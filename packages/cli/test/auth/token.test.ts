import * as crypto from 'node:crypto'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import type {MeResponse, TokenResponse} from '../../src/lib/auth/contract'
import {clearCredentials, parseApiKey, readCredentials, writeCredentials} from '../../src/lib/auth/credentials'
import {withLock} from '../../src/lib/auth/lock'
import {BLOCK_START} from '../../src/lib/auth/npmrc'
import {credentialsPath, lockPath, tokenCachePath} from '../../src/lib/auth/paths'
import type {Prompter} from '../../src/lib/auth/prompt'
import {acceptTerms, type AuthContext, clearTokenCache, ensureRegistryAuth, refreshAfterRegistryAuthError, takeRegistryRetry} from '../../src/lib/auth/token'
import {VendingError, type VendingClient} from '../../src/lib/auth/vending-client'
import {
  API_KEY,
  assertNoSecrets,
  KEY_ID,
  MERCHANT,
  meResponse,
  OTHER_API_KEY,
  OTHER_TOKEN,
  REGISTRY_URL,
  TOKEN,
  tokenResponse,
  TOOLS_REGISTRY_URL,
} from '../helpers/fixtures'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const HOUR = 60 * 60 * 1000

type MintReply = TokenResponse | VendingError | (() => Promise<TokenResponse> | TokenResponse)

const apiError = (code: string, status: number, details: Record<string, string> = {}) =>
  new VendingError({kind: 'api', path: '/v1/tokens', code: code as never, status, details, requestId: 'JTHoQgr2oAMEPMg='})

describe('ensureRegistryAuth', () => {
  let home: string
  let project: string
  let env: NodeJS.ProcessEnv
  let output: string[]
  let mints: MintReply[]
  let mintCount: number
  let meReply: MeResponse
  let accepted: unknown[]
  let acceptError: VendingError | undefined
  let promptAnswers: string[]

  const vending: VendingClient = {
    baseUrl: 'mock',
    me: async () => meReply,
    terms: async () => meReply.terms,
    acceptTerms: async (_key, request) => {
      if (acceptError) throw acceptError
      accepted.push(request)
      return {status: 'active', termsVersion: request.termsVersion, acceptedAt: 'now'}
    },
    mint: async () => {
      mintCount += 1
      const reply = mints.shift() ?? tokenResponse({}, NOW)
      if (reply instanceof VendingError) throw reply
      return typeof reply === 'function' ? reply() : reply
    },
  }

  const prompter = (interactive: boolean): Prompter => ({
    interactive,
    line: async () => promptAnswers.shift() ?? '',
    hidden: async () => '',
  })

  const context = (overrides: Partial<AuthContext> = {}): AuthContext => ({
    env,
    vending,
    prompt: prompter(true),
    log: message => output.push(message),
    warn: message => output.push(`warn: ${message}`),
    now: () => NOW,
    lockOptions: {pollMs: 5},
    ...overrides,
  })

  const login = (apiKey = API_KEY, merchant = MERCHANT, keyExpiresAt = '2027-06-01T00:00:00Z') =>
    writeCredentials(env, {version: 1, apiKey: parseApiKey(apiKey), keyId: parseApiKey(apiKey).keyId, merchant, loggedInAt: 'then', keyExpiresAt})

  const writeProject = (dir: string, appName = 'Acme', appUuid = MERCHANT.appUuid): void => {
    mkdirSync(dir, {recursive: true})
    writeFileSync(join(dir, 'reactiv.conf.js'), `module.exports = {appUuid: '${appUuid}', appName: '${appName}'}\n`)
    writeFileSync(join(dir, 'package.json'), '{}')
  }

  const cache = () => JSON.parse(readFileSync(tokenCachePath(env), 'utf8'))

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'token-'))
    project = join(home, 'project')
    env = {HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache')}
    output = []
    mints = []
    mintCount = 0
    meReply = meResponse()
    accepted = []
    acceptError = undefined
    promptAnswers = []
  })

  afterEach(() => {
    assertNoSecrets(...output)
    rmSync(home, {recursive: true, force: true})
  })

  it('fails with the not-logged-in message when there is no key at all', async () => {
    await expect(ensureRegistryAuth(context())).rejects.toThrow(
      'Not logged in. Run `reactiv login` with the API key Reactiv issued to your team.',
    )
    expect(mintCount).toBe(0)
  })

  it('mints once, caches with mode 0600, and reuses the cache while it has an hour left', async () => {
    login()
    const first = await ensureRegistryAuth(context())
    expect(first).toMatchObject({token: TOKEN, registryUrl: REGISTRY_URL, toolsRegistryUrl: TOOLS_REGISTRY_URL, merchant: MERCHANT})
    expect(statSync(tokenCachePath(env)).mode & 0o777).toBe(0o600)
    expect(tokenCachePath(env)).toBe(join(home, 'cache', 'reactiv', 'token-cache.json'))
    expect(cache()).toEqual({
      version: 1,
      keyId: KEY_ID,
      token: TOKEN,
      expiresAt: new Date(NOW + 12 * HOUR).toISOString(),
      registryUrl: REGISTRY_URL,
      toolsRegistryUrl: TOOLS_REGISTRY_URL,
      merchant: MERCHANT,
      mintedAt: new Date(NOW).toISOString(),
    })
    await ensureRegistryAuth(context())
    expect(mintCount).toBe(1)
  })

  it('re-mints when the cached token has less than 60 minutes left', async () => {
    login()
    mints.push(tokenResponse({expiresAt: new Date(NOW + 61 * 60 * 1000).toISOString()}))
    await ensureRegistryAuth(context())
    await ensureRegistryAuth(context())
    expect(mintCount).toBe(1)
    await ensureRegistryAuth(context({now: () => NOW + 2 * 60 * 1000}))
    expect(mintCount).toBe(2)
  })

  it('never reuses a cache minted for another key or another merchant', async () => {
    login()
    await ensureRegistryAuth(context())
    const stale = cache()
    writeFileSync(tokenCachePath(env), JSON.stringify({...stale, keyId: 'rpk_01J8ZQ4W6R8V2X9N3M5K7T1P0D', token: OTHER_TOKEN}))
    expect((await ensureRegistryAuth(context())).token).toBe(TOKEN)
    writeFileSync(tokenCachePath(env), JSON.stringify({...stale, merchant: {...MERCHANT, slug: 'other'}, token: OTHER_TOKEN}))
    expect((await ensureRegistryAuth(context())).token).toBe(TOKEN)
    expect(mintCount).toBe(3)
  })

  it('forces a re-mint after a registry E401 even with a fresh cache', async () => {
    login()
    await ensureRegistryAuth(context())
    mints.push(tokenResponse({token: OTHER_TOKEN}))
    expect((await refreshAfterRegistryAuthError(context())).token).toBe(OTHER_TOKEN)
    expect(mintCount).toBe(2)
  })

  it('reports a failed heal after E401 with the vending error', async () => {
    login()
    mints.push(apiError('merchant_suspended', 403))
    await expect(refreshAfterRegistryAuthError(context())).rejects.toThrow(/^Registry token could not be refreshed: /)
  })

  it.each([
    ['key_revoked', {revokedAt: '2026-09-30T10:00:00Z', reason: 'rotated'}, 'Your Reactiv API key was revoked on 2026-09-30T10:00:00Z (rotated).'],
    ['key_expired', {expiredAt: '2026-09-30T10:00:00Z'}, 'Your Reactiv API key expired on 2026-09-30T10:00:00Z.'],
  ])('%s deletes the stored key and the cache', async (code, details, message) => {
    login()
    await ensureRegistryAuth(context())
    mints.push(apiError(code, 401, details))
    await expect(ensureRegistryAuth(context(), undefined, {forceRefresh: true})).rejects.toThrow(message)
    expect(existsSync(credentialsPath(env))).toBe(false)
    expect(existsSync(tokenCachePath(env))).toBe(false)
  })

  it('an environment key is used instead of the stored login, which it never reads, writes or deletes', async () => {
    login(OTHER_API_KEY)
    const before = readFileSync(credentialsPath(env))
    utimesSync(credentialsPath(env), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
    const auth = await ensureRegistryAuth(context({env: {...env, REACTIV_API_KEY: API_KEY}}))
    expect(auth.merchant).toEqual(MERCHANT)
    expect(cache().keyId).toBe(KEY_ID)
    expect(readFileSync(credentialsPath(env))).toEqual(before)
    expect(statSync(credentialsPath(env)).mtime.toISOString()).toBe('2020-01-01T00:00:00.000Z')
  })

  it.each(['key_revoked', 'key_expired'])('%s on the environment key leaves the stored login alone', async code => {
    login(OTHER_API_KEY)
    mints.push(apiError(code, 401))
    await expect(ensureRegistryAuth(context({env: {...env, REACTIV_API_KEY: API_KEY}}))).rejects.toThrow()
    expect(readCredentials(env)?.apiKey.reveal()).toBe(OTHER_API_KEY)
  })

  it('a malformed environment key fails without echoing it', async () => {
    await expect(ensureRegistryAuth(context({env: {...env, REACTIV_API_KEY: 'rpk_nope'}}))).rejects.toThrow(
      'REACTIV_API_KEY is not a valid Reactiv API key',
    )
  })

  it('runs the terms flow inline on terms_not_accepted, then retries the mint once', async () => {
    login()
    const document = Buffer.from('terms v3')
    meReply = meResponse({
      status: 'terms_stale',
      terms: {version: 'v3', url: 'https://terms.example.test/v3', sha256: crypto.createHash('sha256').update(document).digest('hex'), acceptedVersion: 'v2'},
    })
    mints.push(apiError('terms_not_accepted', 403, {termsUrl: 'https://terms.example.test/v3', termsVersion: 'v3'}))
    promptAnswers = ['I agree', 'y']
    const auth = await ensureRegistryAuth(context({fetchDocument: async () => document}))
    expect(auth.token).toBe(TOKEN)
    expect(accepted).toEqual([{termsVersion: 'v3', acceptedBy: 'jane.doe@example.test'}])
    expect(mintCount).toBe(2)
  })

  it.each([
    ['key_revoked', {revokedAt: '2026-10-01T12:00:00Z', reason: 'rotated'}, 'was revoked on 2026-10-01T12:00:00Z'],
    ['key_expired', {expiredAt: '2026-10-01T12:00:00Z'}, 'expired on 2026-10-01T12:00:00Z'],
  ])('%s from the terms-accept call still deletes the stored key', async (code, details, message) => {
    login()
    const document = Buffer.from('terms v3')
    meReply = meResponse({
      status: 'terms_stale',
      terms: {version: 'v3', url: 'https://terms.example.test/v3', sha256: crypto.createHash('sha256').update(document).digest('hex'), acceptedVersion: 'v2'},
    })
    mints.push(apiError('terms_not_accepted', 403, {termsVersion: 'v3'}))
    acceptError = new VendingError({kind: 'api', path: '/v1/terms/accept', code: code as never, status: 401, details})
    promptAnswers = ['I agree', 'y']
    await expect(ensureRegistryAuth(context({fetchDocument: async () => document}))).rejects.toThrow(message)
    expect(existsSync(credentialsPath(env))).toBe(false)
    expect(existsSync(tokenCachePath(env))).toBe(false)
  })

  it("a revoked key at terms acceptance never deletes a different stored key", async () => {
    login(OTHER_API_KEY)
    const document = Buffer.from('terms')
    meReply = meResponse({status: 'pending_terms', terms: {...meResponse().terms, sha256: crypto.createHash('sha256').update(document).digest('hex')}})
    acceptError = new VendingError({kind: 'api', path: '/v1/terms/accept', code: 'key_revoked', status: 401, details: {revokedAt: 'x', reason: 'y'}})
    promptAnswers = ['I agree', 'y']
    const pasted = parseApiKey(API_KEY)
    await expect(acceptTerms(context({fetchDocument: async () => document}), {source: 'file', apiKey: pasted, keyId: pasted.keyId, merchant: MERCHANT}, meReply)).rejects.toThrow('was revoked')
    expect(readCredentials(env)?.apiKey.reveal()).toBe(OTHER_API_KEY)
  })

  it('the project-mismatch message never prints key material from a hostile identity', async () => {
    writeProject(project)
    meReply = meResponse({merchant: {slug: 'acme', appUuid: API_KEY}})
    const error = (await ensureRegistryAuth(context({env: {...env, REACTIV_API_KEY: API_KEY}}), project).catch((e: unknown) => e)) as Error
    expect(error.message).toContain('Logged in as acme ([redacted])')
    assertNoSecrets(error.message)
    expect(mintCount).toBe(0)
  })

  it('allows one registry retry per command', () => {
    const ctx = context()
    expect(takeRegistryRetry(ctx)).toBe(true)
    expect(takeRegistryRetry(ctx)).toBe(false)
    expect(takeRegistryRetry(context())).toBe(true)
  })

  it('never prompts for terms on the environment-key path', async () => {
    mints.push(apiError('terms_not_accepted', 403, {termsVersion: 'v3'}))
    const error = (await ensureRegistryAuth(context({env: {...env, REACTIV_API_KEY: API_KEY}})).catch((e: unknown) => e)) as Error
    expect(error.message).toContain('Terms version v3 must be accepted interactively once: run `reactiv login` on a terminal.')
    expect(accepted).toEqual([])
  })

  it('discards the token and clears cache and stored key when the mint answers for another merchant', async () => {
    login()
    writeProject(project)
    mints.push(tokenResponse({merchant: {slug: 'acme', appUuid: '00000000-0000-0000-0000-000000000000'}}))
    await expect(ensureRegistryAuth(context(), project)).rejects.toThrow(
      'Merchant mismatch — your stored key may have changed. Run `reactiv login` again.',
    )
    expect(existsSync(tokenCachePath(env))).toBe(false)
    expect(existsSync(credentialsPath(env))).toBe(false)
    expect(existsSync(join(project, '.npmrc'))).toBe(false)
  })

  it('refuses a project of another merchant before minting or writing anything', async () => {
    login()
    writeProject(project, 'Globex', '11111111-1111-1111-1111-111111111111')
    await expect(ensureRegistryAuth(context(), project)).rejects.toThrow(
      `Logged in as acme (${MERCHANT.appUuid}), but this project belongs to globex (11111111-1111-1111-1111-111111111111). Log in with that merchant's key or switch projects.`,
    )
    expect(mintCount).toBe(0)
    expect(existsSync(join(project, '.npmrc'))).toBe(false)
    expect(existsSync(tokenCachePath(env))).toBe(false)
  })

  it('refuses a project whose app UUID matches but whose name does not', async () => {
    login()
    writeProject(project, 'Someone Else')
    await expect(ensureRegistryAuth(context(), project)).rejects.toThrow('this project belongs to someone-else')
    expect(mintCount).toBe(0)
  })

  it('writes the managed block into every install root of the project', async () => {
    login()
    writeProject(project)
    writeProject(join(project, 'app'))
    const auth = await ensureRegistryAuth(context(), project)
    expect(auth.writtenFiles).toEqual([join(project, '.npmrc'), join(project, 'app', '.npmrc')])
    for (const file of auth.writtenFiles) {
      expect(readFileSync(file, 'utf8')).toContain(BLOCK_START)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
    expect((await ensureRegistryAuth(context(), project)).writtenFiles).toEqual([])
  })

  it('caches the mint but leaves an unsafe .npmrc untouched', async () => {
    login()
    writeProject(project)
    writeFileSync(join(project, '.npmrc'), `${BLOCK_START}\nmine=1\n`)
    await expect(ensureRegistryAuth(context(), project)).rejects.toThrow('without its partner')
    expect(cache().token).toBe(TOKEN)
    expect(readFileSync(join(project, '.npmrc'), 'utf8')).toBe(`${BLOCK_START}\nmine=1\n`)
  })

  it('stale-writer rule: a logout during the mint means nothing is written', async () => {
    login()
    writeProject(project)
    mints.push(() => {
      clearCredentials(env)
      clearTokenCache(env)
      return tokenResponse({}, NOW)
    })
    await expect(ensureRegistryAuth(context(), project)).rejects.toThrow('Your login changed while the registry token was being refreshed')
    expect(existsSync(tokenCachePath(env))).toBe(false)
    expect(existsSync(join(project, '.npmrc'))).toBe(false)
  })

  it('stale-writer rule: a logout holding the lock after the mint serializes ahead of the write', async () => {
    login()
    writeProject(project)
    let releaseLogout: () => void = () => undefined
    let logout: Promise<void> | undefined
    mints.push(async () => {
      logout = withLock(lockPath(env), () => new Promise<void>(resolve => {
        clearCredentials(env)
        clearTokenCache(env)
        releaseLogout = resolve
      }))
      await new Promise(resolve => setTimeout(resolve, 20))
      return tokenResponse({}, NOW)
    })
    const refresh = ensureRegistryAuth(context(), project)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(existsSync(join(project, '.npmrc'))).toBe(false)
    releaseLogout()
    await logout
    await expect(refresh).rejects.toThrow('nothing was written')
    expect(existsSync(tokenCachePath(env))).toBe(false)
    expect(existsSync(join(project, '.npmrc'))).toBe(false)
  })

  // Root ignores file modes, so the cache cannot be made unreadable there.
  it.skipIf(process.getuid?.() === 0)('an unreadable cache warns once and mints per command instead of failing', async () => {
    login()
    mkdirSync(join(home, 'cache', 'reactiv'), {recursive: true})
    writeFileSync(tokenCachePath(env), '{}')
    chmodSync(tokenCachePath(env), 0o000)
    chmodSync(join(home, 'cache', 'reactiv'), 0o500)
    try {
      const ctx = context()
      await ensureRegistryAuth(ctx)
      await ensureRegistryAuth(ctx)
      expect(mintCount).toBe(2)
      expect(output.filter(line => line.includes('Cannot use the token cache'))).toHaveLength(1)
    } finally {
      chmodSync(join(home, 'cache', 'reactiv'), 0o700)
      chmodSync(tokenCachePath(env), 0o600)
    }
  })

  it('warns once when the key expires within 14 days', async () => {
    login(API_KEY, MERCHANT, new Date(NOW + 13 * 24 * HOUR).toISOString())
    const ctx = context()
    await ensureRegistryAuth(ctx)
    await ensureRegistryAuth(ctx)
    const warnings = output.filter(line => line.includes('Your Reactiv API key expires on'))
    expect(warnings).toEqual([`warn: Your Reactiv API key expires on ${new Date(NOW + 13 * 24 * HOUR).toISOString()}; ask Reactiv for a new one before then.`])
  })

  it('does not warn when the key has more than 14 days left', async () => {
    login(API_KEY, MERCHANT, new Date(NOW + 15 * 24 * HOUR).toISOString())
    await ensureRegistryAuth(context())
    expect(output.some(line => line.includes('expires on'))).toBe(false)
  })

  it('reports the cached token expiry when the service is unreachable', async () => {
    login()
    await ensureRegistryAuth(context())
    mints.push(new VendingError({kind: 'unreachable', path: '/v1/tokens', requestId: 'JTHoQgr2oAMEPMg='}))
    await expect(ensureRegistryAuth(context({now: () => NOW + 11.5 * HOUR}))).rejects.toThrow(
      `Reactiv's token service is unreachable (request JTHoQgr2oAMEPMg=). Your cached token is valid until ${new Date(NOW + 12 * HOUR).toISOString()}; try again in a few minutes.`,
    )
  })

  it('discards a mint whose registry URL is not a vended-registry endpoint', async () => {
    login()
    writeProject(project)
    mints.push(tokenResponse({registryUrl: 'https://registry.npmjs.org/'}))
    await expect(ensureRegistryAuth(context(), project)).rejects.toThrow('registry URL outside CodeArtifact — nothing written')
    expect(existsSync(tokenCachePath(env))).toBe(false)
    expect(existsSync(join(project, '.npmrc'))).toBe(false)
  })

  it('no captured output or error ever carries the token or key material', async () => {
    login()
    writeProject(project)
    const messages: string[] = []
    for (const reply of [apiError('invalid_api_key', 401), apiError('merchant_suspended', 403), tokenResponse({}, NOW)]) {
      mints.push(reply)
      try {
        await ensureRegistryAuth(context(), project, {forceRefresh: true})
      } catch (error) {
        messages.push((error as Error).message)
      }
    }
    assertNoSecrets(...messages, ...output)
  })
})
