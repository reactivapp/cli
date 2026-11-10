import type {SubmitResponse} from './auth/contract/submit'
import {AuthError, sanitizeForOutput} from './auth/errors'
import {withRequestId} from './auth/messages'
import {type AuthContext, resolveIdentity, vendingFailure} from './auth/token'
import {VendingError} from './auth/vending-client'

export const recordSubmission = async (ctx: AuthContext, version: string): Promise<SubmitResponse> => {
  const identity = await resolveIdentity(ctx)
  return (await ctx.vending.submit(identity.apiKey, {version})).data
}

// The submissions route answered 404, or answered 2xx without a submission.
const isUnservedRecord = (error: VendingError): boolean =>
  error.kind === 'api' && (error.code === 'not_found' || error.status === 404 || (error.status !== undefined && error.status < 300))

/** True when running the same record call again later can succeed. */
export const isRetryable = (error: unknown): boolean =>
  error instanceof VendingError && (error.kind === 'unreachable' || error.kind === 'rate_limited' || isUnservedRecord(error))

/**
 * The reason to print for a failed record call. Key and store refusals get the
 * same text and stored-login cleanup as every other call. The cases where that
 * text would speak of the token service, the token cache or updating the CLI
 * have their own sentence here.
 */
export const describeRecordFailure = async (ctx: AuthContext, error: unknown): Promise<string> => {
  if (error instanceof VendingError && error.kind === 'rate_limited') {
    return withRequestId('Too many submissions — try again later.', error.requestId)
  }
  if (error instanceof VendingError && error.kind === 'unreachable') {
    return withRequestId('Reactiv could not be reached to record the submission.', error.requestId)
  }
  if (error instanceof VendingError && isUnservedRecord(error)) {
    const sentence =
      error.status === 404 || error.code === 'not_found'
        ? 'Reactiv could not find the submissions service (HTTP 404). Contact Reactiv if this continues.'
        : `Reactiv's answer did not contain the submission (HTTP ${error.status}). Contact Reactiv if this continues.`
    return withRequestId(sentence, error.requestId)
  }
  try {
    await vendingFailure(ctx, ctx.memo?.identity, error)
  } catch (failure) {
    if (failure instanceof AuthError) return failure.message
    if (failure instanceof Error) return `The submission could not be recorded: ${sanitizeForOutput(failure.message)}`
  }
  return 'The submission could not be recorded.'
}

export const recordCommand = (version: string): string => `reactiv app submit --record ${sanitizeForOutput(version)}`

export const publishedNotRecorded = (version: string): string =>
  `Version ${sanitizeForOutput(version)} is published but not recorded. Once the cause is fixed, record it without publishing again:`
