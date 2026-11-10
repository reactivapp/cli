import type {SubmitResponse} from './auth/contract/submit'
import {AuthError, sanitizeForOutput} from './auth/errors'
import {withRequestId} from './auth/messages'
import {type AuthContext, resolveIdentity, vendingFailure} from './auth/token'
import {VendingError} from './auth/vending-client'

export const recordSubmission = async (ctx: AuthContext, version: string): Promise<SubmitResponse> => {
  const identity = await resolveIdentity(ctx)
  return (await ctx.vending.submit(identity.apiKey, {version})).data
}

/** True when running the same record call again later can succeed. */
export const isRetryable = (error: unknown): boolean =>
  error instanceof VendingError && (error.kind === 'unreachable' || error.kind === 'rate_limited')

/**
 * The reason to print for a failed record call. It is the same text, and the
 * same stored-login cleanup for a revoked or expired key, as for any other
 * call, except where the shared text speaks of token requests or the token cache.
 */
export const describeRecordFailure = async (ctx: AuthContext, error: unknown): Promise<string> => {
  if (error instanceof VendingError && error.kind === 'rate_limited') {
    return withRequestId('Too many submissions — try again later.', error.requestId)
  }
  if (error instanceof VendingError && error.kind === 'unreachable') {
    return withRequestId('Reactiv could not be reached to record the submission.', error.requestId)
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
