import {sanitizeForOutput} from './errors'
import type {VendingError} from './vending-client'

export const NOT_LOGGED_IN = 'Not logged in. Run `reactiv login` with the API key Reactiv issued to your team.'

export const UNSUPPORTED_PLATFORM = 'Reactiv Plus Private Beta supports macOS and Linux; Windows is not yet supported.'

export const KEY_UNKNOWN = 'Reactiv did not recognise this API key. Check for a copy/paste error, or ask Reactiv to re-issue it.'

export const MERCHANT_MISMATCH = 'Merchant mismatch — your stored key may have changed. Run `reactiv login` again.'

export const ENV_KEY_GUIDANCE = [
  'REACTIV_API_KEY is set, so it is used instead of any stored login; the key is never written to disk. Registry tokens still go to the token cache and the project .npmrc.',
  'To set it without leaving the key in your shell history: read -rs REACTIV_API_KEY && export REACTIV_API_KEY',
  "In CI, inject it from the pipeline's secret store; never write it into a workflow file.",
]

export const keyRevoked = (revokedAt: string, reason: string): string =>
  `Your Reactiv API key was revoked on ${revokedAt} (${reason}). Ask Reactiv for a new key, then run \`reactiv login\`.`

export const keyExpired = (expiredAt: string): string =>
  `Your Reactiv API key expired on ${expiredAt}. Ask Reactiv for a new key, then run \`reactiv login\`.`

export const keyExpiringSoon = (expiresAt: string): string =>
  `Your Reactiv API key expires on ${expiresAt}; ask Reactiv for a new one before then.`

export const acceptorMismatch = (holder: string): string =>
  `This key was issued to ${holder}; accept the terms as that person, or ask Reactiv for your own key.`

export const termsMustBeInteractive = (version: string): string =>
  `Terms version ${version} must be accepted interactively once: run \`reactiv login\` on a terminal.`

export const termsDocumentMismatch = (url: string, version: string): string =>
  `The terms document at ${url} does not match the version Reactiv published (${version}); nothing was accepted — try again later or contact Reactiv.`

export const termsNotAcceptedForWhoami = (version: string): string =>
  `Terms version ${version} not accepted — run \`reactiv login\`.`

export const projectMismatch = (loggedIn: {slug: string; appUuid: string}, project: {slug: string; appUuid: string}): string =>
  `Logged in as ${sanitizeForOutput(loggedIn.slug)} (${sanitizeForOutput(loggedIn.appUuid)}), but this project belongs to ${sanitizeForOutput(project.slug)} (${sanitizeForOutput(project.appUuid)}). Log in with that merchant's key or switch projects.`

export const vendingUnreachable = (requestId: string | undefined, cachedTokenExpiresAt: string | undefined): string => {
  const request = `request ${requestId ?? 'id unavailable'}`
  return cachedTokenExpiresAt
    ? `Reactiv's token service is unreachable (${request}). Your cached token is valid until ${cachedTokenExpiresAt}; try again in a few minutes.`
    : `Reactiv's token service is unreachable (${request}). Try again in a few minutes.`
}

export const registryRefreshFailed = (vendingMessage: string): string =>
  `Registry token could not be refreshed: ${vendingMessage}`

const withRequestId = (message: string, requestId: string | undefined): string =>
  requestId ? `${message}\nRequest id: ${sanitizeForOutput(requestId)}` : message

export const describeVendingError = (error: VendingError, cachedTokenExpiresAt?: string): string => {
  const detail = (name: string): string => sanitizeForOutput(error.details[name] ?? 'unknown')
  if (error.kind === 'unreachable') return vendingUnreachable(error.requestId && sanitizeForOutput(error.requestId), cachedTokenExpiresAt)
  if (error.kind === 'rate_limited') {
    return withRequestId(
      error.retryAfterSeconds === undefined
        ? 'Too many requests — try again in a minute.'
        : `Too many token requests; retry after ${error.retryAfterSeconds} s.`,
      error.requestId,
    )
  }
  switch (error.code) {
    case 'invalid_api_key':
      return withRequestId(KEY_UNKNOWN, error.requestId)
    case 'key_revoked':
      return withRequestId(keyRevoked(detail('revokedAt'), detail('reason')), error.requestId)
    case 'key_expired':
      return withRequestId(keyExpired(detail('expiredAt')), error.requestId)
    case 'acceptor_mismatch':
      return withRequestId(acceptorMismatch(detail('holder')), error.requestId)
    case 'merchant_suspended':
      return withRequestId(
        error.serverMessage ? sanitizeForOutput(error.serverMessage) : 'This merchant is suspended — contact Reactiv.',
        error.requestId,
      )
    case 'terms_not_accepted':
      return withRequestId(termsNotAcceptedForWhoami(detail('termsVersion')), error.requestId)
    case 'merchant_unknown':
      return withRequestId('Merchant not provisioned — contact Reactiv.', error.requestId)
    case 'not_found':
      return withRequestId(
        error.path.startsWith('/v1/')
          ? "Reactiv's token service no longer serves this CLI's API version — update the CLI (npm i -g @reactivapp/cli)."
          : "Reactiv's token service did not recognise the request.",
        error.requestId,
      )
    default:
      return withRequestId(
        error.serverMessage
          ? sanitizeForOutput(error.serverMessage)
          : `Reactiv's token service returned an unexpected response${error.status ? ` (HTTP ${error.status})` : ''}.`,
        error.requestId,
      )
  }
}
