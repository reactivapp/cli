import {spawn} from 'node:child_process'
import * as http from 'node:http'
import type {AddressInfo} from 'node:net'
import {join} from 'node:path'
import {expect} from 'vitest'

import type {MeResponse, TokenResponse} from '../../src/lib/auth/contract'

export const binPath = join(__dirname, '..', '..', 'bin', 'run')

const canonical = (secret: string): string => Buffer.from(secret, 'base64url').toString('base64url')

export const ULID = '01J8ZQ4W6R8V2X9N3M5K7T1P0C'
export const OTHER_ULID = '01J8ZQ4W6R8V2X9N3M5K7T1P0D'
// The secret half deliberately contains several `_` and `-` characters.
export const SECRET = canonical('a_b-'.repeat(10) + 'c_d')
export const API_KEY = `rpk_${ULID}_${SECRET}`
export const KEY_ID = `rpk_${ULID}`
export const OTHER_API_KEY = `rpk_${OTHER_ULID}_${canonical('Zz9-'.repeat(10) + 'Q_r')}`

export const TOKEN = 'mock-vended-token.Q2xhdWRlIHRlc3Q=/x+y'
export const OTHER_TOKEN = 'mock-vended-token.second-mint'

export const MERCHANT = {slug: 'acme', appUuid: '3f1c9a2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b'}
export const REGISTRY_HOST = 'reactivapp-000000000000.d.codeartifact.us-east-1.amazonaws.com'
export const REGISTRY_URL = `https://${REGISTRY_HOST}/npm/submissions-acme/`
export const TOOLS_REGISTRY_URL = `https://${REGISTRY_HOST}/npm/tools/`

// Request ids are opaque strings, not UUIDs.
let requestCounter = 0
export const opaqueRequestId = (): string => `JTHoQgr2oAMEP${String(requestCounter++).padStart(3, '0')}=`

export const meResponse = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  keyId: KEY_ID,
  label: 'acme/jane.doe',
  holder: 'jane.doe@example.test',
  expiresAt: '2027-06-01T00:00:00Z',
  status: 'active',
  merchant: MERCHANT,
  terms: {
    version: 'test-terms-v1',
    url: 'https://terms.example.test/reactiv-plus.pdf',
    sha256: '0'.repeat(64),
    acceptedVersion: 'test-terms-v1',
  },
  ...overrides,
})

export const tokenResponse = (overrides: Partial<TokenResponse> = {}, now = Date.now()): TokenResponse => ({
  token: TOKEN,
  expiresAt: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
  registryUrl: REGISTRY_URL,
  toolsRegistryUrl: TOOLS_REGISTRY_URL,
  merchant: MERCHANT,
  ...overrides,
})

export const assertNoSecrets = (...outputs: string[]): void => {
  for (const output of outputs) {
    expect(output).not.toContain(TOKEN)
    expect(output).not.toContain(OTHER_TOKEN)
    expect(output).not.toContain(SECRET)
    expect(output).not.toMatch(/rpk_/)
  }
}

export interface MockReply {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export interface RecordedRequest {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: string
}

export type MockRoutes = Record<string, (request: RecordedRequest) => MockReply>

export const startMockVending = async (routes: MockRoutes) => {
  const requests: RecordedRequest[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const recorded = {method: req.method ?? '', path: req.url ?? '', headers: req.headers, body}
      requests.push(recorded)
      const handler = routes[`${req.method} ${req.url}`]
      const requestId = opaqueRequestId()
      const reply = handler ? handler(recorded) : {status: 404, body: {code: 'not_found', message: 'no route', retryable: false, requestId}}
      res.writeHead(reply.status, {'content-type': 'application/json', 'x-request-id': requestId, ...reply.headers})
      const payload = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
      res.end(payload)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

export const errorReply = (status: number, code: string, details?: Record<string, string>, headers?: Record<string, string>): MockReply => ({
  status,
  headers,
  body: {code, message: `mock ${code}`, retryable: status >= 500 || status === 429, requestId: opaqueRequestId(), ...(details ? {details} : {})},
})

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
  errorText: string
}

const ANSI = /\u001b\[[0-9;]*m/g
const flattenError = (stderr: string): string =>
  stderr.replace(ANSI, '').replace(/^\s*›\s*(Error:)?\s*/gm, '').replace(/\s+/g, ' ').trim()

// Async on purpose: a sync spawn would block the in-process mock server.
export const runCli = (args: string[], options: {cwd?: string; env: NodeJS.ProcessEnv; input?: string}): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn('node', [binPath, ...args], {cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe']})
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => resolve({code, stdout, stderr, errorText: flattenError(stderr)}))
    child.stdin.end(options.input ?? '')
  })

export const isolatedEnv = (home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(REACTIV_|npm_config_|XDG_|FORCE_COLOR$|CLICOLOR|NO_COLOR$)/i.test(key)) continue
    env[key] = value
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
    ...extra,
  }
}
