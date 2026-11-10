import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

import {parseApiKey} from '../src/lib/auth/credentials'
import type {AuthContext} from '../src/lib/auth/token'
import {createVendingClient} from '../src/lib/auth/vending-client'
import {describeRecordFailure, isRetryable, publishedNotRecorded, recordCommand, recordSubmission} from '../src/lib/devtools-submit'
import {
  API_KEY,
  assertNoSecrets,
  DASHBOARD_URL,
  errorReply,
  KEY_ID,
  MERCHANT,
  opaqueRequestId,
  SUBMISSION_ID,
  submitResponse,
  type MockReply,
} from './helpers/fixtures'

const key = parseApiKey(API_KEY)
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, {recursive: true, force: true})
})

// A client on a fake fetch with recorded sleeps; the identity is already resolved, so only the record call goes out.
const fakeRecord = (replies: Array<MockReply | Error>) => {
  const sleeps: number[] = []
  const calls: Array<{url: string; init: RequestInit}> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({url, init})
    const next = replies.shift()
    if (!next) throw new Error('no reply queued')
    if (next instanceof Error) throw next
    const body = next.body === undefined ? '' : typeof next.body === 'string' ? next.body : JSON.stringify(next.body)
    return new Response(body, {status: next.status, headers: {'x-request-id': opaqueRequestId(), ...next.headers}})
  }) as unknown as typeof fetch
  const vending = createVendingClient({
    baseUrl: 'https://devtools.test',
    cliVersion: '9.9.9',
    platform: 'darwin',
    fetch: fetchImpl,
    sleep: async ms => {
      sleeps.push(ms)
    },
    onWait: () => {
      throw new Error('the record call must not wait out a 429')
    },
  })
  const home = mkdtempSync(join(tmpdir(), 'record-'))
  homes.push(home)
  const ctx = {
    env: {HOME: home},
    vending,
    log: () => undefined,
    warn: () => undefined,
    now: Date.now,
    memo: {identity: {source: 'env', apiKey: key, keyId: KEY_ID, merchant: MERCHANT}},
  } as unknown as AuthContext
  const record = () => recordSubmission(ctx, '0.1.8-draft.2')
  const failure = async (): Promise<{error: unknown; reason: string}> => {
    try {
      await record()
    } catch (error) {
      return {error, reason: await describeRecordFailure(ctx, error)}
    }
    throw new Error('expected the record call to fail')
  }
  return {record, failure, ctx, sleeps, calls}
}

const unavailable = (): MockReply => errorReply(503, 'upstream_unavailable')
const refusal = (status: number, code: string, message: string, details?: Record<string, string>): MockReply => ({
  status,
  body: {code, message, retryable: false, requestId: 'req-1', ...(details ? {details} : {})},
})

describe('recordSubmission', () => {
  it('posts only the version and returns the unwrapped record', async () => {
    const {record, calls, sleeps} = fakeRecord([{status: 200, body: submitResponse()}])
    await expect(record()).resolves.toEqual({submissionId: SUBMISSION_ID, status: 'Processing', dashboardUrl: DASHBOARD_URL})
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://devtools.test/v1/submissions')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.body).toBe('{"version":"0.1.8-draft.2"}')
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[0].init.headers).toEqual({
      'User-Agent': 'reactiv-cli/9.9.9 (darwin)',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    })
    expect(sleeps).toEqual([])
  })

  it('accepts any status and any link text, so a change on the service does not fail the record', async () => {
    const dashboardUrl = 'a new kind of link'
    const {record} = fakeRecord([{status: 200, body: {data: {submissionId: 'any-id', status: 'Some New Status', dashboardUrl}}}])
    await expect(record()).resolves.toMatchObject({submissionId: 'any-id', dashboardUrl})
  })

  it('tries a 5xx three times in all with the same body, backing off 1 s then 2 s', async () => {
    const {record, calls, sleeps} = fakeRecord([unavailable(), unavailable(), {status: 200, body: submitResponse()}])
    await expect(record()).resolves.toMatchObject({submissionId: SUBMISSION_ID})
    expect(calls.map(call => call.init.body)).toEqual(Array(3).fill('{"version":"0.1.8-draft.2"}'))
    expect(sleeps).toEqual([1000, 2000])
  })

  it('gives up after a third 5xx, as retryable and unreachable', async () => {
    const {failure, calls, sleeps} = fakeRecord([unavailable(), unavailable(), unavailable(), {status: 200, body: submitResponse()}])
    const {error, reason} = await failure()
    expect(isRetryable(error)).toBe(true)
    expect(reason).toMatch(/^Reactiv could not be reached to record the submission\.\nRequest id: \S+$/)
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([1000, 2000])
  })

  it('gives up after three network errors', async () => {
    const {failure, calls, sleeps} = fakeRecord([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')])
    const {error, reason} = await failure()
    expect(isRetryable(error)).toBe(true)
    expect(reason).toBe('Reactiv could not be reached to record the submission.')
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([1000, 2000])
  })

  it('does not wait out a 429 and says the limit is on submissions', async () => {
    const {failure, calls, sleeps} = fakeRecord([
      {status: 429, headers: {'retry-after': '1'}, body: {code: 'rate_limited', message: 'Too many requests. Retry later.', retryable: true, requestId: 'req-2'}},
    ])
    const {error, reason} = await failure()
    expect(isRetryable(error)).toBe(true)
    expect(reason).toBe('Too many submissions — try again later.\nRequest id: req-2')
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it('does not retry an invalid request, and prints the server message', async () => {
    const {failure, calls, sleeps} = fakeRecord([refusal(400, 'invalid_request', 'The request is malformed.')])
    const {error, reason} = await failure()
    expect(isRetryable(error)).toBe(false)
    expect(reason).toBe('The request is malformed.\nRequest id: req-1')
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it('gives a revoked key the same guidance as every other call', async () => {
    const {failure, calls} = fakeRecord([
      refusal(401, 'key_revoked', 'This API key has been revoked.', {revokedAt: '2026-11-01T00:00:00Z', reason: 'contract ended'}),
    ])
    const {error, reason} = await failure()
    expect(isRetryable(error)).toBe(false)
    expect(reason).toContain('2026-11-01T00:00:00Z')
    expect(reason).toContain('contract ended')
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['a missing data envelope', submitResponse().data],
    ['a submission id that is not a string', submitResponse({submissionId: 42 as never})],
    ['a missing link', {data: {submissionId: SUBMISSION_ID, status: 'Processing'}}],
    ['a link that is not a string', submitResponse({dashboardUrl: 42 as never})],
  ])('rejects a 2xx with %s and keeps its request id', async (_label, body) => {
    const {failure, calls} = fakeRecord([{status: 200, body, headers: {'x-request-id': 'req-7'}}])
    const {error, reason} = await failure()
    expect(isRetryable(error)).toBe(false)
    expect(reason).toBe("Reactiv's token service returned an unexpected response (HTTP 200).\nRequest id: req-7")
    expect(calls).toHaveLength(1)
  })

  it('never prints the key or control characters from server text', async () => {
    const {failure} = fakeRecord([refusal(400, 'invalid_request', `bad ${API_KEY}\u001b[31m`)])
    const {reason} = await failure()
    expect(reason).toBe('bad [redacted][31m\nRequest id: req-1')
    assertNoSecrets(reason)
  })
})

describe('describeRecordFailure', () => {
  it('gives any other error a plain reason instead of rethrowing it', async () => {
    const {ctx} = fakeRecord([])
    expect(isRetryable(new Error('EACCES'))).toBe(false)
    await expect(describeRecordFailure(ctx, new Error('EACCES: permission denied\u001b[2J'))).resolves.toBe(
      'The submission could not be recorded: EACCES: permission denied[2J',
    )
    await expect(describeRecordFailure(ctx, 'thrown string')).resolves.toBe('The submission could not be recorded.')
  })
})

describe('recovery text', () => {
  it('names the version, and the command stands alone', () => {
    expect(publishedNotRecorded('0.1.8-draft.2')).toBe(
      'Version 0.1.8-draft.2 is published but not recorded. Once the cause is fixed, record it without publishing again:',
    )
    expect(recordCommand('0.1.8-draft.2')).toBe('reactiv app submit --record 0.1.8-draft.2')
  })
})
