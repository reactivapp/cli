import * as http from 'node:http'
import type {AddressInfo} from 'node:net'
import {describe, expect, it} from 'vitest'

import {parseApiKey} from '../../src/lib/auth/credentials'
import {describeVendingError} from '../../src/lib/auth/messages'
import {
  createVendingClient,
  DEFAULT_VENDING_API_URL,
  parseRetryAfter,
  resolveVendingApiUrl,
  VendingError,
  type VendingClient,
} from '../../src/lib/auth/vending-client'
import {API_KEY, assertNoSecrets, errorReply, meResponse, opaqueRequestId, tokenResponse, type MockReply} from '../helpers/fixtures'

const key = parseApiKey(API_KEY)

const fakeClient = (replies: Array<MockReply | Error>) => {
  const sleeps: number[] = []
  const calls: Array<{url: string; init: RequestInit}> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({url, init})
    const next = replies.shift()
    if (!next) throw new Error('no reply queued')
    if (next instanceof Error) throw next
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status,
      headers: {'x-request-id': opaqueRequestId(), ...next.headers},
    })
  }) as unknown as typeof fetch
  const client = createVendingClient({
    baseUrl: 'https://vending.test',
    cliVersion: '9.9.9',
    platform: 'darwin',
    fetch: fetchImpl,
    sleep: async ms => {
      sleeps.push(ms)
    },
    now: () => Date.parse('2026-10-01T12:00:00Z'),
  })
  return {client, sleeps, calls}
}

const failure = async (promise: Promise<unknown>): Promise<VendingError> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof VendingError) return error
    throw error
  }
  throw new Error('expected a VendingError')
}

describe('resolveVendingApiUrl', () => {
  it('uses the compiled default unless REACTIV_VENDING_API_URL is set', () => {
    expect(resolveVendingApiUrl({})).toEqual({url: DEFAULT_VENDING_API_URL, overridden: false})
    expect(resolveVendingApiUrl({REACTIV_VENDING_API_URL: 'https://staging.example.test/'})).toEqual({url: 'https://staging.example.test', overridden: true})
  })

  it('accepts plain http only on loopback', () => {
    expect(resolveVendingApiUrl({REACTIV_VENDING_API_URL: 'http://127.0.0.1:4010'}).url).toBe('http://127.0.0.1:4010')
    expect(resolveVendingApiUrl({REACTIV_VENDING_API_URL: 'http://[::1]:4010'}).url).toBe('http://[::1]:4010')
    expect(() => resolveVendingApiUrl({REACTIV_VENDING_API_URL: 'http://localhost:4010'})).toThrow('must be an https URL')
    expect(() => resolveVendingApiUrl({REACTIV_VENDING_API_URL: 'http://vending.example.test'})).toThrow('must be an https URL')
    expect(() => resolveVendingApiUrl({REACTIV_VENDING_API_URL: 'https://u:p@vending.example.test'})).toThrow('must be an https URL')
  })
})

describe('vending client requests', () => {
  it('sends the key as a bearer header, the CLI user agent, and refuses redirects', async () => {
    const {client, calls} = fakeClient([{status: 200, body: tokenResponse()}])
    await client.mint(key)
    expect(calls[0].url).toBe('https://vending.test/v1/tokens')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`)
    expect(headers['User-Agent']).toBe('reactiv-cli/9.9.9 (darwin)')
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0].url).not.toContain('rpk_')
  })

  it('posts terms acceptance as JSON', async () => {
    const {client, calls} = fakeClient([{status: 200, body: {status: 'active', termsVersion: 'v', acceptedAt: 'now'}}])
    await client.acceptTerms(key, {termsVersion: 'v', acceptedBy: 'jane@example.test'})
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({termsVersion: 'v', acceptedBy: 'jane@example.test'})
  })

  it('makes 3 attempts on 503, waiting 1 s then 2 s, then reports the service unreachable', async () => {
    const {client, sleeps, calls} = fakeClient([errorReply(503, 'upstream_unavailable'), errorReply(503, 'upstream_unavailable'), errorReply(503, 'upstream_unavailable')])
    const error = await failure(client.mint(key))
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([1000, 2000])
    expect(error.kind).toBe('unreachable')
    expect(describeVendingError(error, '2026-10-01T20:00:00Z')).toMatch(
      /^Reactiv's token service is unreachable \(request JTHoQgr2oAMEP\d{3}=\)\. Your cached token is valid until 2026-10-01T20:00:00Z; try again in a few minutes\.$/,
    )
  })

  it('recovers when a retry succeeds', async () => {
    const {client, sleeps} = fakeClient([errorReply(503, 'upstream_unavailable'), {status: 200, body: tokenResponse()}])
    await expect(client.mint(key)).resolves.toMatchObject({registryUrl: tokenResponse().registryUrl})
    expect(sleeps).toEqual([1000])
  })

  it('treats network failures and the 10 s timeout like an unavailable service', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const {client, sleeps, calls} = fakeClient([new TypeError('fetch failed'), timeout, timeout])
    const error = await failure(client.me(key))
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([1000, 2000])
    expect(describeVendingError(error)).toBe("Reactiv's token service is unreachable (request id unavailable). Try again in a few minutes.")
  })

  it('gives up on a request that does not answer within the timeout', async () => {
    const hang = http.createServer(() => undefined)
    await new Promise<void>(resolve => hang.listen(0, '127.0.0.1', resolve))
    try {
      const {port} = hang.address() as AddressInfo
      const slow = createVendingClient({baseUrl: `http://127.0.0.1:${port}`, cliVersion: '1', timeoutMs: 50, sleep: async () => undefined})
      const started = Date.now()
      const error = await failure(slow.me(key))
      expect(error.kind).toBe('unreachable')
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      hang.closeAllConnections()
      hang.close()
    }
  })

  it('honours Retry-After once on 429, then fails with the wait it was given', async () => {
    const {client, sleeps, calls} = fakeClient([
      errorReply(429, 'rate_limited', undefined, {'retry-after': '7'}),
      errorReply(429, 'rate_limited', undefined, {'retry-after': '9'}),
    ])
    const error = await failure(client.mint(key))
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([7000])
    expect(describeVendingError(error).split('\n')[0]).toBe('Too many token requests; retry after 9 s.')
  })

  it('fails at once when Retry-After asks for more than a timer can wait', async () => {
    const {client, sleeps, calls} = fakeClient([errorReply(429, 'rate_limited', undefined, {'retry-after': '9999999999'})])
    const error = await failure(client.mint(key))
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(describeVendingError(error).split('\n')[0]).toBe('Too many token requests; retry after 9999999999 s.')
  })

  it('succeeds after honouring Retry-After', async () => {
    const {client, sleeps} = fakeClient([errorReply(429, 'rate_limited', undefined, {'retry-after': '3'}), {status: 200, body: tokenResponse()}])
    await client.mint(key)
    expect(sleeps).toEqual([3000])
  })

  it("waits a fixed 5 s on a 429 with no code and no Retry-After, retries once, then fails", async () => {
    const bare429 = {status: 429, body: {message: 'Too Many Requests'}}
    const {client, sleeps, calls} = fakeClient([bare429, bare429])
    const error = await failure(client.mint(key))
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([5000])
    expect(describeVendingError(error).split('\n')[0]).toBe('Too many requests — try again in a minute.')
  })

  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('2026-10-01T12:00:00Z')
    expect(parseRetryAfter('12', now)).toBe(12)
    expect(parseRetryAfter('Thu, 01 Oct 2026 12:00:30 GMT', now)).toBe(30)
    expect(parseRetryAfter('soon', now)).toBeUndefined()
    expect(parseRetryAfter(null, now)).toBeUndefined()
  })

  it('does not retry a non-retryable error and keeps its details and request id', async () => {
    const {client, calls} = fakeClient([errorReply(401, 'key_revoked', {revokedAt: '2026-09-30T10:00:00Z', reason: 'left the agency'})])
    const error = await failure(client.mint(key))
    expect(calls).toHaveLength(1)
    expect(error.code).toBe('key_revoked')
    expect(error.requestId).toMatch(/^JTHoQgr2oAMEP\d{3}=$/)
    const message = describeVendingError(error)
    expect(message.split('\n')[0]).toBe(
      'Your Reactiv API key was revoked on 2026-09-30T10:00:00Z (left the agency). Ask Reactiv for a new key, then run `reactiv login`.',
    )
    expect(message).toMatch(/Request id: JTHoQgr2oAMEP\d{3}=/)
  })
})

describe('response shape validation', () => {
  const malformed = (body: unknown): MockReply => ({status: 200, body})

  it.each([
    ['GET /v1/me', (c: VendingClient) => c.me(key), [null, {}, meResponse({status: 'revoked' as never}), {...meResponse(), terms: null}, {...meResponse(), merchant: {slug: 'x'}}]],
    ['GET /v1/terms', (c: VendingClient) => c.terms(), [null, [], {version: 'v', url: 'u'}]],
    ['POST /v1/terms/accept', (c: VendingClient) => c.acceptTerms(key, {termsVersion: 'v', acceptedBy: 'a'}), [null, {status: 'pending_terms', termsVersion: 'v', acceptedAt: 'now'}, {status: 'active'}]],
    ['POST /v1/tokens', (c: VendingClient) => c.mint(key), [null, 'token', {...tokenResponse(), token: 42}, {...tokenResponse(), merchant: undefined}, {...tokenResponse(), registryUrl: undefined}]],
  ] as const)('%s: a structurally invalid 200 is a controlled error, not a crash', async (_, request, bodies) => {
    for (const body of bodies) {
      const {client} = fakeClient([malformed(body)])
      const error = await failure(request(client))
      expect(error.kind).toBe('api')
      expect(error.code).toBeUndefined()
      expect(describeVendingError(error).split('\n')[0]).toBe("Reactiv's token service returned an unexpected response (HTTP 200).")
    }
  })

  it('accepts a well-formed body for every response type', async () => {
    const {client} = fakeClient([
      {status: 200, body: meResponse()},
      {status: 200, body: {version: 'v', url: 'https://t.example.test', sha256: 'a'}},
      {status: 200, body: {status: 'active', termsVersion: 'v', acceptedAt: 'now'}},
      {status: 200, body: tokenResponse()},
    ])
    await expect(client.me(key)).resolves.toMatchObject({status: 'active'})
    await expect(client.terms()).resolves.toMatchObject({version: 'v'})
    await expect(client.acceptTerms(key, {termsVersion: 'v', acceptedBy: 'a'})).resolves.toMatchObject({status: 'active'})
    await expect(client.mint(key)).resolves.toMatchObject({registryUrl: tokenResponse().registryUrl})
  })

  it('treats an error body without code and message strings as unrecognised', async () => {
    const {client} = fakeClient([{status: 403, body: {code: 'key_revoked'}}])
    const error = await failure(client.mint(key))
    expect(error.code).toBeUndefined()
    expect(describeVendingError(error).split('\n')[0]).toBe("Reactiv's token service returned an unexpected response (HTTP 403).")
  })
})

describe('failure messages', () => {
  const vendingError = (code: string, details: Record<string, string> = {}, path = '/v1/tokens') =>
    new VendingError({kind: 'api', path, code: code as never, details, requestId: 'JTHoQgr2oAMEPMg='})

  it.each([
    ['invalid_api_key', {}, 'Reactiv did not recognise this API key. Check for a copy/paste error, or ask Reactiv to re-issue it.'],
    ['key_expired', {expiredAt: '2026-09-01T00:00:00Z'}, 'Your Reactiv API key expired on 2026-09-01T00:00:00Z. Ask Reactiv for a new key, then run `reactiv login`.'],
    ['acceptor_mismatch', {holder: 'jane@example.test'}, 'This key was issued to jane@example.test; accept the terms as that person, or ask Reactiv for your own key.'],
    ['merchant_unknown', {}, 'Merchant not provisioned — contact Reactiv.'],
  ])('%s → the exact one-line message plus the request id', (code, details, expected) => {
    const message = describeVendingError(vendingError(code, details))
    expect(message).toBe(`${expected}\nRequest id: JTHoQgr2oAMEPMg=`)
  })

  it('prints the service message for merchant_suspended and invalid_request, with the request id', () => {
    const suspended = new VendingError({kind: 'api', path: '/v1/tokens', code: 'merchant_suspended', status: 403, serverMessage: 'Merchant acme is suspended — contact Reactiv.', requestId: 'JTHoQgr2oAMEPMg='})
    expect(describeVendingError(suspended)).toBe('Merchant acme is suspended — contact Reactiv.\nRequest id: JTHoQgr2oAMEPMg=')
    const invalid = new VendingError({kind: 'api', path: '/v1/tokens', code: 'invalid_request', status: 400, serverMessage: 'body must be empty', requestId: 'JTHoQgr2oAMEPMg='})
    expect(describeVendingError(invalid)).toBe('body must be empty\nRequest id: JTHoQgr2oAMEPMg=')
  })

  it('falls back to a fixed sentence when merchant_suspended carries no message', () => {
    expect(describeVendingError(vendingError('merchant_suspended')).split('\n')[0]).toBe('This merchant is suspended — contact Reactiv.')
  })

  it('names the terms version if terms_not_accepted ever reaches the user', () => {
    expect(describeVendingError(vendingError('terms_not_accepted', {termsVersion: 'v3'})).split('\n')[0]).toBe('Terms version v3 not accepted — run `reactiv login`.')
  })

  it('asks for a CLI update on a 404 under /v1/', () => {
    expect(describeVendingError(vendingError('not_found', {}, '/v1/me'))).toContain('update the CLI')
  })

  it('strips control characters and key material from server-supplied text', () => {
    const message = describeVendingError(vendingError('key_revoked', {revokedAt: 'x\u001b[2J', reason: `leak ${API_KEY}\nforged line`}))
    expect(message).not.toContain('\u001b')
    expect(message.split('\n')[0]).toContain('leak [redacted]forged line')
    assertNoSecrets(message)
  })

  it('treats a non-JSON 502 from a proxy as unavailable', async () => {
    const {client, calls} = fakeClient([{status: 502, body: '<html>'}, {status: 502}, {status: 502}])
    const error = await failure(client.me(key))
    expect(calls).toHaveLength(3)
    expect(error.kind).toBe('unreachable')
  })
})

