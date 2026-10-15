import * as fs from 'node:fs'
import * as path from 'node:path'

import {loadProjectIdentity} from '../project'
import type {MeResponse, TokenResponse} from './contract'
import {type ApiKey, clearCredentials, type Merchant, parseApiKey, readCredentials} from './credentials'
import {AuthError, sanitizeForOutput} from './errors'
import {ensurePrivateDir, errorCode, removeFileIfPresent, writeFileAtomic} from './files'
import {type LockOptions, withLock} from './lock'
import {
  describeVendingError,
  keyExpiringSoon,
  MERCHANT_MISMATCH,
  NOT_LOGGED_IN,
  projectMismatch,
  registryRefreshFailed,
  termsMustBeInteractive,
} from './messages'
import {assertTokenSafe, installRoots, renderBlock, validateRegistryUrl, writeManagedBlocks} from './npmrc'
import {lockPath, tokenCachePath} from './paths'
import type {Prompter} from './prompt'
import {type FetchDocument, runTermsAcceptance} from './terms'
import {VendingError, type VendingClient} from './vending-client'

export const API_KEY_ENV = 'REACTIV_API_KEY'
export const REFRESH_BEFORE_EXPIRY_MS = 60 * 60 * 1000
export const KEY_EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1000

export interface AuthContext {
  env: NodeJS.ProcessEnv
  vending: VendingClient
  prompt: Prompter
  log: (message: string) => void
  warn: (message: string) => void
  now: () => number
  fetchDocument?: FetchDocument
  lockOptions?: LockOptions
  memo?: {identity?: Identity; me?: MeResponse; warnedCache?: boolean; warnedExpiry?: boolean; registryRetryUsed?: boolean}
}

export interface Identity {
  source: 'file' | 'env'
  apiKey: ApiKey
  keyId: string
  merchant: Merchant
  keyExpiresAt?: string
}

export interface RegistryAuth {
  token: string
  expiresAt: string
  registryUrl: string
  toolsRegistryUrl: string
  merchant: Merchant
  writtenFiles: string[]
}

interface TokenCache {
  version: 1
  keyId: string
  token: string
  expiresAt: string
  registryUrl: string
  toolsRegistryUrl: string
  merchant: Merchant
  mintedAt: string
}

const memo = (ctx: AuthContext): NonNullable<AuthContext['memo']> => (ctx.memo ??= {})

const sameMerchant = (a: Merchant, b: Merchant): boolean => a.slug === b.slug && a.appUuid === b.appUuid

const isPermissionError = (error: unknown): boolean => ['EACCES', 'EPERM'].includes(errorCode(error) ?? '')

const warnCacheUnusable = (ctx: AuthContext): void => {
  if (memo(ctx).warnedCache) return
  memo(ctx).warnedCache = true
  ctx.warn(`Cannot use the token cache at ${tokenCachePath(ctx.env)} (permission denied); continuing without it, so every command mints a fresh token.`)
}

export const readTokenCache = (ctx: AuthContext): TokenCache | undefined => {
  let raw: string
  try {
    raw = fs.readFileSync(tokenCachePath(ctx.env), 'utf8')
  } catch (error) {
    if (isPermissionError(error)) warnCacheUnusable(ctx)
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as TokenCache
    if (parsed.version !== 1 || typeof parsed.token !== 'string' || typeof parsed.keyId !== 'string') return undefined
    if (typeof parsed.merchant?.slug !== 'string' || typeof parsed.merchant?.appUuid !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

const writeTokenCache = (ctx: AuthContext, cache: TokenCache): void => {
  const file = tokenCachePath(ctx.env)
  try {
    ensurePrivateDir(path.dirname(file))
    writeFileAtomic(file, JSON.stringify(cache, null, 2) + '\n')
  } catch (error) {
    if (!isPermissionError(error)) throw error
    warnCacheUnusable(ctx)
  }
}

export const clearTokenCache = (env: NodeJS.ProcessEnv): void => {
  try {
    removeFileIfPresent(tokenCachePath(env))
  } catch (error) {
    if (!isPermissionError(error)) throw error
  }
}

const deleteFileLogin = async (ctx: AuthContext, keyId: string): Promise<void> => {
  await withLock(lockPath(ctx.env), () => {
    clearTokenCache(ctx.env)
    let stored
    try {
      stored = readCredentials(ctx.env)
    } catch {
      return
    }
    if (stored?.keyId === keyId) clearCredentials(ctx.env)
  }, ctx.lockOptions)
}

const vendingFailure = async (ctx: AuthContext, identity: Identity | undefined, error: unknown): Promise<never> => {
  if (!(error instanceof VendingError)) throw error
  if ((error.code === 'key_revoked' || error.code === 'key_expired') && identity?.source === 'file') {
    await deleteFileLogin(ctx, identity.keyId)
  }
  const cache = identity ? readTokenCache(ctx) : undefined
  const cachedExpiry =
    cache && identity && cache.keyId === identity.keyId && Date.parse(cache.expiresAt) > ctx.now() ? cache.expiresAt : undefined
  throw new AuthError(describeVendingError(error, cachedExpiry))
}

export const fetchMe = async (ctx: AuthContext, identity: Identity): Promise<MeResponse> => {
  try {
    return await ctx.vending.me(identity.apiKey)
  } catch (error) {
    return vendingFailure(ctx, identity, error)
  }
}

export const currentMe = async (ctx: AuthContext, identity: Identity): Promise<MeResponse> => {
  const known = memo(ctx).me
  return known && identity.source === 'env' ? known : fetchMe(ctx, identity)
}

const envTermsError = (version: string): AuthError =>
  new AuthError(
    `${termsMustBeInteractive(sanitizeForOutput(version))}\n${API_KEY_ENV} is set; unset it for that one login and paste the key at the prompt.`,
  )

export const resolveIdentity = async (ctx: AuthContext, options: {allowPendingTerms?: boolean} = {}): Promise<Identity> => {
  const cached = memo(ctx).identity
  if (cached) return cached
  const envKey = ctx.env[API_KEY_ENV]
  let identity: Identity
  if (envKey !== undefined && envKey !== '') {
    let apiKey: ApiKey
    try {
      apiKey = parseApiKey(envKey)
    } catch {
      throw new AuthError(`${API_KEY_ENV} is not a valid Reactiv API key. Check for a copy/paste error, or ask Reactiv to re-issue it.`)
    }
    const partial: Identity = {source: 'env', apiKey, keyId: apiKey.keyId, merchant: {slug: '', appUuid: ''}}
    const me = await fetchMe(ctx, partial)
    memo(ctx).me = me
    if (me.status !== 'active' && !options.allowPendingTerms) throw envTermsError(me.terms.version)
    identity = {...partial, merchant: me.merchant, keyExpiresAt: me.expiresAt}
    if (me.status !== 'active') return identity
  } else {
    const stored = readCredentials(ctx.env)
    if (!stored) throw new AuthError(NOT_LOGGED_IN)
    identity = {source: 'file', apiKey: stored.apiKey, keyId: stored.keyId, merchant: stored.merchant, keyExpiresAt: stored.keyExpiresAt}
  }
  memo(ctx).identity = identity
  return identity
}

export const assertProjectBinding = (merchant: Merchant, project: {slug: string; appUuid: string}): void => {
  if (merchant.appUuid !== project.appUuid || merchant.slug !== project.slug) {
    throw new AuthError(projectMismatch(merchant, project))
  }
}

export const warnIfKeyExpiring = (ctx: AuthContext, keyExpiresAt: string | undefined): void => {
  if (!keyExpiresAt || memo(ctx).warnedExpiry) return
  const remaining = Date.parse(keyExpiresAt) - ctx.now()
  if (remaining > 0 && remaining < KEY_EXPIRY_WARNING_MS) {
    memo(ctx).warnedExpiry = true
    ctx.warn(keyExpiringSoon(sanitizeForOutput(keyExpiresAt)))
  }
}

export const acceptTerms = async (ctx: AuthContext, identity: Identity, me: MeResponse): Promise<void> => {
  try {
    await runTermsAcceptance({
      me,
      apiKey: identity.apiKey,
      vending: ctx.vending,
      prompt: ctx.prompt,
      log: ctx.log,
      fetchDocument: ctx.fetchDocument,
    })
  } catch (error) {
    return vendingFailure(ctx, identity, error)
  }
}

const mint = async (ctx: AuthContext, identity: Identity): Promise<TokenResponse> => {
  try {
    return await ctx.vending.mint(identity.apiKey)
  } catch (error) {
    if (!(error instanceof VendingError) || error.code !== 'terms_not_accepted') return vendingFailure(ctx, identity, error)
    if (identity.source === 'env') throw envTermsError(error.details.termsVersion ?? 'unknown')
    await acceptTerms(ctx, identity, await fetchMe(ctx, identity))
    try {
      return await ctx.vending.mint(identity.apiKey)
    } catch (retryError) {
      return vendingFailure(ctx, identity, retryError)
    }
  }
}

const cacheIsUsable = (cache: TokenCache | undefined, identity: Identity, now: number): cache is TokenCache => {
  if (!cache || cache.keyId !== identity.keyId || !sameMerchant(cache.merchant, identity.merchant)) return false
  if (!(Date.parse(cache.expiresAt) - now >= REFRESH_BEFORE_EXPIRY_MS)) return false
  try {
    validateRegistryUrl(cache.registryUrl)
    validateRegistryUrl(cache.toolsRegistryUrl)
    assertTokenSafe(cache.token)
    return true
  } catch {
    return false
  }
}

const bindProject = (identity: Identity, projectRoot: string): void => {
  let project
  try {
    project = loadProjectIdentity(projectRoot)
  } catch (error) {
    throw new AuthError(error instanceof Error ? error.message : String(error))
  }
  assertProjectBinding(identity.merchant, project)
}

export interface EnsureOptions {
  forceRefresh?: boolean
}

export const ensureRegistryAuth = async (
  ctx: AuthContext,
  projectRoot?: string,
  options: EnsureOptions = {},
): Promise<RegistryAuth> => {
  const identity = await resolveIdentity(ctx)
  if (projectRoot) bindProject(identity, projectRoot)
  warnIfKeyExpiring(ctx, identity.keyExpiresAt)

  const cache = readTokenCache(ctx)
  let fresh: TokenCache | undefined
  let auth: Omit<RegistryAuth, 'writtenFiles'>
  if (!options.forceRefresh && cacheIsUsable(cache, identity, ctx.now())) {
    auth = cache
  } else {
    const response = await mint(ctx, identity)
    const token = assertTokenSafe(response.token)
    const registryUrl = validateRegistryUrl(response.registryUrl)
    const toolsRegistryUrl = validateRegistryUrl(response.toolsRegistryUrl)
    if (!Number.isFinite(Date.parse(response.expiresAt))) {
      throw new AuthError('vending API returned an unreadable token expiry — nothing written')
    }
    if (!response.merchant || !sameMerchant(response.merchant, identity.merchant)) {
      if (identity.source === 'file') await deleteFileLogin(ctx, identity.keyId)
      else clearTokenCache(ctx.env)
      throw new AuthError(MERCHANT_MISMATCH)
    }
    fresh = {
      version: 1,
      keyId: identity.keyId,
      token,
      expiresAt: response.expiresAt,
      registryUrl,
      toolsRegistryUrl,
      merchant: identity.merchant,
      mintedAt: new Date(ctx.now()).toISOString(),
    }
    auth = fresh
  }

  const block = renderBlock(auth)
  const roots = projectRoot ? installRoots(projectRoot) : []
  // Re-read and writes share one lock, so a concurrent logout cannot land
  // between the check and the writes.
  const writtenFiles = await withLock(lockPath(ctx.env), () => {
    if (identity.source === 'file') {
      const current = readCredentials(ctx.env)
      if (!current || current.keyId !== identity.keyId) {
        throw new AuthError('Your login changed while the registry token was being refreshed (logout or a new login); nothing was written. Run the command again.')
      }
    }
    if (fresh) writeTokenCache(ctx, fresh)
    return writeManagedBlocks(roots, block, {log: ctx.log})
  }, ctx.lockOptions)

  return {
    token: auth.token,
    expiresAt: auth.expiresAt,
    registryUrl: auth.registryUrl,
    toolsRegistryUrl: auth.toolsRegistryUrl,
    merchant: auth.merchant,
    writtenFiles,
  }
}

// A command gets one E401-triggered re-mint in total, across all its npm calls.
export const takeRegistryRetry = (ctx: AuthContext): boolean => {
  if (memo(ctx).registryRetryUsed) return false
  memo(ctx).registryRetryUsed = true
  return true
}

export const refreshAfterRegistryAuthError = async (ctx: AuthContext, projectRoot?: string): Promise<RegistryAuth> => {
  try {
    return await ensureRegistryAuth(ctx, projectRoot, {forceRefresh: true})
  } catch (error) {
    if (error instanceof AuthError) throw new AuthError(registryRefreshFailed(error.message))
    throw error
  }
}
