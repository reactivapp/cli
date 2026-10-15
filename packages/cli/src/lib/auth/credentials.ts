import * as fs from 'node:fs'
import * as path from 'node:path'
import {inspect} from 'node:util'

import {AuthError} from './errors'
import {ensurePrivateDir, errorCode, removeFileIfPresent, writeFileAtomic} from './files'
import {credentialsPath} from './paths'

// rpk_<26-char Crockford ULID>_<43-char base64url secret>
export const API_KEY_PATTERN = /^rpk_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/

const REDACTED = '[redacted API key]'

export class ApiKey {
  readonly keyId: string
  readonly #value: string

  constructor(value: string, keyId: string) {
    this.#value = value
    this.keyId = keyId
  }

  reveal(): string {
    return this.#value
  }

  toString(): string {
    return REDACTED
  }

  toJSON(): string {
    return REDACTED
  }

  [inspect.custom](): string {
    return REDACTED
  }
}

// Positional parse: the base64url secret can itself contain `_`. Only the
// canonical base64url spelling of the secret is accepted.
export const parseApiKey = (input: string): ApiKey => {
  const value = input.trim()
  if (!API_KEY_PATTERN.test(value)) {
    throw new AuthError('That is not a valid Reactiv API key. Check for a copy/paste error, or ask Reactiv to re-issue it.')
  }
  const keyId = value.slice(0, 30)
  const secret = value.slice(31)
  if (Buffer.from(secret, 'base64url').toString('base64url') !== secret) {
    throw new AuthError('That is not a valid Reactiv API key. Check for a copy/paste error, or ask Reactiv to re-issue it.')
  }
  return new ApiKey(value, keyId)
}

export interface Merchant {
  slug: string
  appUuid: string
}

export interface StoredCredentials {
  version: 1
  apiKey: ApiKey
  keyId: string
  merchant: Merchant
  loggedInAt: string
  keyExpiresAt?: string
}

const isMerchant = (value: unknown): value is Merchant =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Merchant).slug === 'string' &&
  typeof (value as Merchant).appUuid === 'string'

const corrupt = (file: string): AuthError =>
  new AuthError(`The stored login at ${file} is unreadable. Run \`reactiv logout\`, then \`reactiv login\` again.`)

export const readCredentials = (env: NodeJS.ProcessEnv): StoredCredentials | undefined => {
  const file = credentialsPath(env)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw new AuthError(`Could not read the stored login at ${file} (${errorCode(error) ?? 'unknown error'}).`)
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw corrupt(file)
  }
  if (parsed.version !== 1 || typeof parsed.apiKey !== 'string' || !isMerchant(parsed.merchant)) throw corrupt(file)
  let apiKey: ApiKey
  try {
    apiKey = parseApiKey(parsed.apiKey)
  } catch {
    throw corrupt(file)
  }
  if (parsed.keyId !== apiKey.keyId) throw corrupt(file)
  return {
    version: 1,
    apiKey,
    keyId: apiKey.keyId,
    merchant: {slug: parsed.merchant.slug, appUuid: parsed.merchant.appUuid},
    loggedInAt: typeof parsed.loggedInAt === 'string' ? parsed.loggedInAt : '',
    keyExpiresAt: typeof parsed.keyExpiresAt === 'string' ? parsed.keyExpiresAt : undefined,
  }
}

export const writeCredentials = (env: NodeJS.ProcessEnv, credentials: StoredCredentials): void => {
  const file = credentialsPath(env)
  ensurePrivateDir(path.dirname(file))
  const serialized = {
    version: 1,
    apiKey: credentials.apiKey.reveal(),
    keyId: credentials.keyId,
    merchant: credentials.merchant,
    loggedInAt: credentials.loggedInAt,
    ...(credentials.keyExpiresAt ? {keyExpiresAt: credentials.keyExpiresAt} : {}),
  }
  writeFileAtomic(file, JSON.stringify(serialized, null, 2) + '\n')
}

export const clearCredentials = (env: NodeJS.ProcessEnv): void => {
  removeFileIfPresent(credentialsPath(env))
}
