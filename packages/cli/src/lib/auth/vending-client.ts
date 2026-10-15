import type {ApiKey} from './credentials'
import type {ErrorCode, ErrorResponse, MeResponse, TermsAcceptRequest, TermsAcceptResponse, TermsResponse, TokenResponse} from './contract'
import {AuthError} from './errors'

export const DEFAULT_VENDING_API_URL = 'https://plus-devtools-staging.dev.reactivapp.com'
export const VENDING_URL_ENV = 'REACTIV_VENDING_API_URL'

export const REQUEST_TIMEOUT_MS = 10_000
export const UNAVAILABLE_BACKOFF_MS = [1000, 2000]
export const FALLBACK_RATE_LIMIT_WAIT_S = 5
const MAX_TIMER_MS = 2 ** 31 - 1

// IP literals only: a name like localhost can resolve off the machine.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]'])

// Plain http only on loopback (local mocks): the API key travels in a header.
export const resolveVendingApiUrl = (env: NodeJS.ProcessEnv): {url: string; overridden: boolean} => {
  const override = env[VENDING_URL_ENV]
  if (override === undefined || override === '') return {url: DEFAULT_VENDING_API_URL, overridden: false}
  let url: URL
  try {
    url = new URL(override)
  } catch {
    throw new AuthError(`${VENDING_URL_ENV} is not a valid URL.`)
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  if (!secure || url.username || url.password || url.search || url.hash) {
    throw new AuthError(`${VENDING_URL_ENV} must be an https URL without credentials, query or fragment.`)
  }
  return {url: url.href.replace(/\/+$/, ''), overridden: true}
}

export type VendingFailureKind = 'api' | 'unreachable' | 'rate_limited'

export class VendingError extends Error {
  readonly kind: VendingFailureKind
  readonly code?: ErrorCode
  readonly status?: number
  readonly requestId?: string
  readonly details: Record<string, string>
  readonly serverMessage?: string
  readonly retryAfterSeconds?: number
  readonly path: string

  constructor(init: {
    kind: VendingFailureKind
    path: string
    code?: ErrorCode
    status?: number
    requestId?: string
    details?: Record<string, string>
    serverMessage?: string
    retryAfterSeconds?: number
  }) {
    super(`vending API ${init.kind}${init.code ? ` (${init.code})` : ''}`)
    this.name = 'VendingError'
    this.kind = init.kind
    this.path = init.path
    this.code = init.code
    this.status = init.status
    this.requestId = init.requestId
    this.details = init.details ?? {}
    this.serverMessage = init.serverMessage
    this.retryAfterSeconds = init.retryAfterSeconds
  }
}

export interface VendingClient {
  readonly baseUrl: string
  me(key: ApiKey): Promise<MeResponse>
  terms(): Promise<TermsResponse>
  acceptTerms(key: ApiKey, request: TermsAcceptRequest): Promise<TermsAcceptResponse>
  mint(key: ApiKey): Promise<TokenResponse>
}

export interface VendingClientOptions {
  baseUrl: string
  cliVersion: string
  platform?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  timeoutMs?: number
  onWait?: (message: string) => void
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

type Guard<T> = (value: unknown) => value is T

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const isMerchant = (value: unknown): boolean => isRecord(value) && isString(value.slug) && isString(value.appUuid)

export const isMeResponse: Guard<MeResponse> = (value): value is MeResponse =>
  isRecord(value) &&
  isString(value.keyId) &&
  isString(value.label) &&
  isString(value.holder) &&
  isString(value.expiresAt) &&
  (value.status === 'pending_terms' || value.status === 'active' || value.status === 'terms_stale') &&
  isMerchant(value.merchant) &&
  isRecord(value.terms) &&
  isString(value.terms.version) &&
  isString(value.terms.url) &&
  isString(value.terms.sha256) &&
  (value.terms.acceptedVersion === null || isString(value.terms.acceptedVersion))

export const isTermsResponse: Guard<TermsResponse> = (value): value is TermsResponse =>
  isRecord(value) && isString(value.version) && isString(value.url) && isString(value.sha256)

export const isTermsAcceptResponse: Guard<TermsAcceptResponse> = (value): value is TermsAcceptResponse =>
  isRecord(value) && value.status === 'active' && isString(value.termsVersion) && isString(value.acceptedAt)

export const isTokenResponse: Guard<TokenResponse> = (value): value is TokenResponse =>
  isRecord(value) &&
  isString(value.token) &&
  isString(value.expiresAt) &&
  isString(value.registryUrl) &&
  isString(value.toolsRegistryUrl) &&
  isMerchant(value.merchant)

export const isErrorResponse = (value: unknown): value is Pick<ErrorResponse, 'code' | 'message'> & Partial<ErrorResponse> =>
  isRecord(value) &&
  isString(value.code) &&
  isString(value.message) &&
  (value.requestId === undefined || isString(value.requestId)) &&
  (value.details === undefined || isRecord(value.details))

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const parseErrorBody = (text: string): Partial<ErrorResponse> | undefined => {
  const parsed = parseJson(text)
  return isErrorResponse(parsed) ? parsed : undefined
}

export const parseRetryAfter = (header: string | null, now: number): number | undefined => {
  if (header === null) return undefined
  const value = header.trim()
  if (/^\d+$/.test(value)) return Number(value)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000))
  return undefined
}

const stringDetails = (details: unknown): Record<string, string> => {
  if (typeof details !== 'object' || details === null) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

export const createVendingClient = (options: VendingClientOptions): VendingClient => {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const userAgent = `reactiv-cli/${options.cliVersion} (${options.platform ?? process.platform})`

  const call = async <T>(method: 'GET' | 'POST', path: string, guard: Guard<T>, key?: ApiKey, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = {'User-Agent': userAgent, Accept: 'application/json'}
    if (key) headers.Authorization = `Bearer ${key.reveal()}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    let unavailableFailures = 0
    let rateLimitRetried = false
    for (;;) {
      let status: number
      let text: string
      let requestIdHeader: string | undefined
      let retryAfterHeader: string | null
      try {
        const response = await fetchImpl(`${options.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        })
        status = response.status
        requestIdHeader = response.headers.get('x-request-id') ?? undefined
        retryAfterHeader = response.headers.get('retry-after')
        text = await response.text()
      } catch {
        if (unavailableFailures < UNAVAILABLE_BACKOFF_MS.length) {
          await sleep(UNAVAILABLE_BACKOFF_MS[unavailableFailures])
          unavailableFailures += 1
          continue
        }
        throw new VendingError({kind: 'unreachable', path})
      }

      if (status >= 200 && status < 300) {
        const parsed = parseJson(text)
        if (guard(parsed)) return parsed
        throw new VendingError({kind: 'api', path, status, requestId: requestIdHeader})
      }

      const error = parseErrorBody(text)
      const requestId = (typeof error?.requestId === 'string' ? error.requestId : undefined) ?? requestIdHeader

      if (status === 429) {
        const retryAfter = parseRetryAfter(retryAfterHeader, now())
        const waitSeconds = retryAfter ?? FALLBACK_RATE_LIMIT_WAIT_S
        // Beyond setTimeout's range the timer would fire at once instead of waiting.
        if (!rateLimitRetried && waitSeconds * 1000 <= MAX_TIMER_MS) {
          rateLimitRetried = true
          options.onWait?.(`Reactiv's token service is rate limiting; retrying in ${waitSeconds} s.`)
          await sleep(waitSeconds * 1000)
          continue
        }
        throw new VendingError({kind: 'rate_limited', path, status, requestId, code: error?.code, retryAfterSeconds: retryAfter})
      }

      if (status >= 500) {
        if (unavailableFailures < UNAVAILABLE_BACKOFF_MS.length) {
          await sleep(UNAVAILABLE_BACKOFF_MS[unavailableFailures])
          unavailableFailures += 1
          continue
        }
        throw new VendingError({kind: 'unreachable', path, status, requestId, code: error?.code})
      }

      throw new VendingError({
        kind: 'api',
        path,
        status,
        requestId,
        code: error?.code,
        details: stringDetails(error?.details),
        serverMessage: typeof error?.message === 'string' ? error.message : undefined,
      })
    }
  }

  return {
    baseUrl: options.baseUrl,
    me: key => call('GET', '/v1/me', isMeResponse, key),
    terms: () => call('GET', '/v1/terms', isTermsResponse),
    acceptTerms: (key, request) => call('POST', '/v1/terms/accept', isTermsAcceptResponse, key, request),
    mint: key => call('POST', '/v1/tokens', isTokenResponse, key),
  }
}
