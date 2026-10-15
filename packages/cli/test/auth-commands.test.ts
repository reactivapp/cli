import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {assertSupportedPlatform} from '../src/lib/auth/context'
import {BLOCK_START} from '../src/lib/auth/npmrc'
import {
  API_KEY,
  assertNoSecrets,
  errorReply,
  isolatedEnv,
  KEY_ID,
  MERCHANT,
  meResponse,
  runCli,
  startMockVending,
  tokenResponse,
  type MockReply,
} from './helpers/fixtures'

describe('login / whoami / logout against a mock vending API', () => {
  let home: string
  let mock: Awaited<ReturnType<typeof startMockVending>>
  let meReply: MockReply
  let tokenReply: MockReply
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'auth-cmd-')))
    meReply = {status: 200, body: meResponse()}
    tokenReply = {status: 200, body: tokenResponse()}
    mock = await startMockVending({
      'GET /v1/me': () => meReply,
      'POST /v1/tokens': () => tokenReply,
    })
    env = isolatedEnv(home, {REACTIV_VENDING_API_URL: mock.url})
  })

  afterEach(async () => {
    await mock.close()
    rmSync(home, {recursive: true, force: true})
  })

  const credentials = () => join(home, '.config', 'reactiv', 'credentials.json')

  it('login --with-token validates the key, stores it 0600 and never prints it', async () => {
    const result = await runCli(['login', '--with-token'], {cwd: home, env, input: `${API_KEY}\n`})
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`using vending API ${mock.url}`)
    expect(result.stdout).toContain('Logged in as acme (key acme/jane.doe).')
    expect(result.stdout).toContain('Next: reactiv app init')
    expect(statSync(credentials()).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, '.config', 'reactiv')).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(credentials(), 'utf8'))).toMatchObject({version: 1, keyId: KEY_ID, merchant: MERCHANT})
    const me = mock.requests.find(request => request.path === '/v1/me')
    expect(me?.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(me?.headers['user-agent']).toMatch(/^reactiv-cli\/\d+\.\d+\.\d+ \((darwin|linux)\)$/)
    assertNoSecrets(result.stdout, result.stderr)
  })

  it('login rejects a malformed key before any network call', async () => {
    const result = await runCli(['login', '--with-token'], {cwd: home, env, input: 'rpk_not-a-key\n'})
    expect(result.code).not.toBe(0)
    expect(result.errorText).toContain('That is not a valid Reactiv API key')
    expect(mock.requests).toEqual([])
    expect(existsSync(credentials())).toBe(false)
  })

  it.each([
    ['invalid_api_key', 401, {}, 'Reactiv did not recognise this API key.'],
    ['key_revoked', 401, {revokedAt: '2026-09-30T10:00:00Z', reason: 'rotated'}, 'Your Reactiv API key was revoked on 2026-09-30T10:00:00Z (rotated).'],
    ['key_expired', 401, {expiredAt: '2026-09-30T10:00:00Z'}, 'Your Reactiv API key expired on 2026-09-30T10:00:00Z.'],
  ])('login with a %s key writes nothing', async (code, status, details, message) => {
    meReply = errorReply(status, code, details)
    const result = await runCli(['login', '--with-token'], {cwd: home, env, input: `${API_KEY}\n`})
    expect(result.code).not.toBe(0)
    expect(result.errorText).toContain(message)
    expect(result.errorText).toMatch(/Request id: JTHoQgr2oAMEP\d{3}=/)
    expect(existsSync(credentials())).toBe(false)
    assertNoSecrets(result.stdout, result.stderr)
  })

  it('login refuses to accept terms without a terminal and writes nothing', async () => {
    meReply = {status: 200, body: meResponse({status: 'pending_terms'})}
    const result = await runCli(['login', '--with-token'], {cwd: home, env, input: `${API_KEY}\n`})
    expect(result.code).not.toBe(0)
    expect(result.errorText).toContain('Terms version test-terms-v1 must be accepted interactively once: run `reactiv login` on a terminal.')
    expect(existsSync(credentials())).toBe(false)
    expect(mock.requests.some(request => request.path === '/v1/terms/accept')).toBe(false)
  })

  it('login with REACTIV_API_KEY set only validates: guidance printed, nothing written', async () => {
    const result = await runCli(['login'], {cwd: home, env: {...env, REACTIV_API_KEY: API_KEY}})
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('read -rs REACTIV_API_KEY && export REACTIV_API_KEY')
    expect(result.stdout).toContain('REACTIV_API_KEY is valid for merchant acme.')
    expect(existsSync(credentials())).toBe(false)
    assertNoSecrets(result.stdout, result.stderr)
  })

  it('login inside a project refreshes its .npmrc block', async () => {
    const project = join(home, 'project')
    mkdirSync(project)
    writeFileSync(join(project, 'reactiv.conf.js'), `module.exports = {appUuid: '${MERCHANT.appUuid}', appName: 'Acme'}\n`)
    writeFileSync(join(project, 'package.json'), '{}')
    mkdirSync(join(project, 'src'))
    const result = await runCli(['login', '--with-token'], {cwd: join(project, 'src'), env, input: `${API_KEY}\n`})
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`Refreshed the registry token in ${join(project, '.npmrc')}`)
    expect(readFileSync(join(project, '.npmrc'), 'utf8')).toContain(BLOCK_START)
    assertNoSecrets(result.stdout, result.stderr)
  })

  it('whoami shows merchant, key label, holder, key expiry, status and cache — never the key', async () => {
    await runCli(['login', '--with-token'], {cwd: home, env, input: `${API_KEY}\n`})
    const result = await runCli(['whoami'], {cwd: home, env})
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`Merchant:      acme (${MERCHANT.appUuid})`)
    expect(result.stdout).toContain('Key:           acme/jane.doe')
    expect(result.stdout).toContain('Holder:        jane.doe@example.test')
    expect(result.stdout).toContain('Key expires:   2027-06-01T00:00:00Z')
    expect(result.stdout).toContain('Status:        active')
    expect(result.stdout).toContain('Token cache:   none')
  })

  it('whoami reports an expired cached token as none', async () => {
    tokenReply = {status: 200, body: tokenResponse({expiresAt: '2020-01-01T00:00:00Z'})}
    await runCli(['login', '--with-token'], {cwd: home, env, input: `${API_KEY}\n`})
    const cacheDir = join(home, '.cache', 'reactiv')
    mkdirSync(cacheDir, {recursive: true})
    writeFileSync(join(cacheDir, 'token-cache.json'), JSON.stringify({version: 1, keyId: KEY_ID, token: 'x', expiresAt: '2020-01-01T00:00:00Z', registryUrl: '', toolsRegistryUrl: '', merchant: MERCHANT, mintedAt: ''}))
    const result = await runCli(['whoami'], {cwd: home, env})
    expect(result.stdout).toContain('Token cache:   none')
    assertNoSecrets(result.stdout, result.stderr)
  })

  it('whoami reports terms that still need accepting', async () => {
    await runCli(['login', '--with-token'], {cwd: home, env, input: `${API_KEY}\n`})
    meReply = {status: 200, body: meResponse({status: 'terms_stale', terms: {...meResponse().terms, version: 'v9'}})}
    const result = await runCli(['whoami'], {cwd: home, env})
    expect(result.stdout).toContain('Terms version v9 not accepted — run `reactiv login`.')
  })

  it('a malformed 200 from the vending API is a one-line error, never a stack trace', async () => {
    meReply = {status: 200, body: 'null'}
    const result = await runCli(['login', '--with-token'], {cwd: home, env, input: `${API_KEY}\n`})
    expect(result.code).not.toBe(0)
    expect(result.errorText).toContain("Reactiv's token service returned an unexpected response (HTTP 200).")
    expect(result.stderr).not.toMatch(/TypeError|\n\s+at /)
    expect(existsSync(credentials())).toBe(false)
  })

  it('whoami when nobody is logged in', async () => {
    const result = await runCli(['whoami'], {cwd: home, env})
    expect(result.code).not.toBe(0)
    expect(result.errorText).toContain('Not logged in. Run `reactiv login` with the API key Reactiv issued to your team.')
  })

  it('logout deletes the key and cache, then the project block', async () => {
    const project = join(home, 'project')
    mkdirSync(project)
    writeFileSync(join(project, 'reactiv.conf.js'), `module.exports = {appUuid: '${MERCHANT.appUuid}', appName: 'Acme'}\n`)
    writeFileSync(join(project, 'package.json'), '{}')
    writeFileSync(join(project, '.npmrc'), 'save-exact=true\n')
    await runCli(['login', '--with-token'], {cwd: project, env, input: `${API_KEY}\n`})
    expect(existsSync(join(home, '.cache', 'reactiv', 'token-cache.json'))).toBe(true)
    const result = await runCli(['logout'], {cwd: project, env})
    expect(result.code).toBe(0)
    expect(existsSync(credentials())).toBe(false)
    expect(existsSync(join(home, '.cache', 'reactiv', 'token-cache.json'))).toBe(false)
    expect(readFileSync(join(project, '.npmrc'), 'utf8')).toBe('save-exact=true\n')
    assertNoSecrets(result.stdout, result.stderr)
  })
})

describe('platform prerequisite', () => {
  it('refuses Windows at login', () => {
    expect(() => assertSupportedPlatform('win32')).toThrow('Reactiv Plus Private Beta supports macOS and Linux; Windows is not yet supported.')
    expect(() => assertSupportedPlatform('darwin')).not.toThrow()
    expect(() => assertSupportedPlatform('linux')).not.toThrow()
  })
})
