// Wire types of the Reactiv token-vending API (v1). Keep identical to the
// service's published contract.

// GET /v1/me → 200
export interface MeResponse {
  keyId: string
  label: string
  holder: string
  expiresAt: string
  status: 'pending_terms' | 'active' | 'terms_stale'
  merchant: {slug: string; appUuid: string}
  terms: {version: string; url: string; sha256: string; acceptedVersion: string | null}
}

// POST /v1/terms/accept
export interface TermsAcceptRequest {
  termsVersion: string
  acceptedBy: string
}

export interface TermsAcceptResponse {
  status: 'active'
  termsVersion: string
  acceptedAt: string
}

// GET /v1/health → 200
export interface HealthResponse {
  status: 'ok'
  version: string
}

// GET /v1/terms → 200
export interface TermsResponse {
  version: string
  url: string
  sha256: string
}

// POST /v1/tokens (empty body) → 200
export interface TokenResponse {
  token: string
  expiresAt: string
  registryUrl: string
  toolsRegistryUrl: string
  merchant: {slug: string; appUuid: string}
}

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_api_key'
  | 'key_revoked'
  | 'key_expired'
  | 'acceptor_mismatch'
  | 'terms_not_accepted'
  | 'merchant_unknown'
  | 'merchant_suspended'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'not_found'

// Any non-2xx response.
export interface ErrorResponse {
  code: ErrorCode
  message: string
  retryable: boolean
  requestId: string
  details?: Record<string, string>
}
