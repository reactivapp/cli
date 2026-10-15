import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {inspect} from 'node:util'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {clearCredentials, parseApiKey, readCredentials, writeCredentials} from '../../src/lib/auth/credentials'
import {credentialsPath} from '../../src/lib/auth/paths'
import {API_KEY, KEY_ID, MERCHANT, SECRET, ULID} from '../helpers/fixtures'

describe('parseApiKey', () => {
  it('parses by position even when the secret contains the delimiter', () => {
    expect(SECRET).toMatch(/_.*-|-.*_/)
    const key = parseApiKey(API_KEY)
    expect(key.keyId).toBe(KEY_ID)
    expect(key.keyId).toHaveLength(30)
    expect(key.reveal()).toBe(API_KEY)
  })

  it('accepts the canonical all-0xff secret and rejects its non-canonical alias', () => {
    const secret = Buffer.alloc(32, 0xff).toString('base64url')
    expect(secret.endsWith('8')).toBe(true)
    expect(parseApiKey(`rpk_${ULID}_${secret}`).keyId).toBe(KEY_ID)
    expect(() => parseApiKey(`rpk_${ULID}_${secret.slice(0, -1)}-`)).toThrow('not a valid Reactiv API key')
  })

  it.each([
    ['wrong prefix', `rpx_${ULID}_${SECRET}`],
    ['ULID with a forbidden letter', `rpk_${ULID.slice(0, -1)}U_${SECRET}`],
    ['short secret', `rpk_${ULID}_${SECRET.slice(1)}`],
    ['inner whitespace', `rpk_${ULID}_ ${SECRET.slice(1)}`],
  ])('rejects %s without echoing the input', (_, input) => {
    try {
      parseApiKey(input)
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toContain(input)
      expect((error as Error).message).not.toMatch(/rpk_/)
    }
  })

  it('never prints itself', () => {
    const key = parseApiKey(API_KEY)
    expect(String(key)).not.toContain(SECRET)
    expect(inspect(key)).not.toContain(SECRET)
    expect(inspect({nested: key})).not.toContain(SECRET)
    expect(JSON.stringify({key})).not.toContain(SECRET)
    expect(`${key}`).not.toMatch(/rpk_/)
  })
})

describe('credentials file', () => {
  let home: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'creds-'))
    env = {HOME: home, XDG_CONFIG_HOME: join(home, 'config')}
  })
  afterEach(() => rmSync(home, {recursive: true, force: true}))

  const credentials = () => ({
    version: 1 as const,
    apiKey: parseApiKey(API_KEY),
    keyId: KEY_ID,
    merchant: MERCHANT,
    loggedInAt: '2026-10-01T00:00:00.000Z',
    keyExpiresAt: '2027-06-01T00:00:00Z',
  })

  it('is written atomically with mode 0600 in a 0700 directory, under XDG_CONFIG_HOME', () => {
    writeCredentials(env, credentials())
    const file = credentialsPath(env)
    expect(file).toBe(join(home, 'config', 'reactiv', 'credentials.json'))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, 'config', 'reactiv')).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(home, 'config', 'reactiv')).filter(name => name.endsWith('.tmp'))).toEqual([])
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    expect(stored).toEqual({
      version: 1,
      apiKey: API_KEY,
      keyId: KEY_ID,
      merchant: MERCHANT,
      loggedInAt: '2026-10-01T00:00:00.000Z',
      keyExpiresAt: '2027-06-01T00:00:00Z',
    })
    expect(stored).not.toHaveProperty('vendingApiUrl')
  })

  it('defaults to ~/.config when XDG_CONFIG_HOME is unset or relative', () => {
    expect(credentialsPath({HOME: home})).toBe(join(home, '.config', 'reactiv', 'credentials.json'))
    expect(credentialsPath({HOME: home, XDG_CONFIG_HOME: 'relative/dir'})).toBe(join(home, '.config', 'reactiv', 'credentials.json'))
  })

  it('tightens an existing group-readable directory to 0700', () => {
    mkdirSync(join(home, 'config', 'reactiv'), {recursive: true, mode: 0o755})
    writeCredentials(env, credentials())
    expect(statSync(join(home, 'config', 'reactiv')).mode & 0o777).toBe(0o700)
  })

  it('round-trips and clears', () => {
    expect(readCredentials(env)).toBeUndefined()
    writeCredentials(env, credentials())
    const read = readCredentials(env)
    expect(read?.keyId).toBe(KEY_ID)
    expect(read?.apiKey.reveal()).toBe(API_KEY)
    expect(read?.keyExpiresAt).toBe('2027-06-01T00:00:00Z')
    clearCredentials(env)
    expect(existsSync(credentialsPath(env))).toBe(false)
    clearCredentials(env)
  })

  it('reports a corrupt file without printing its contents', () => {
    mkdirSync(join(home, 'config', 'reactiv'), {recursive: true})
    writeFileSync(credentialsPath(env), JSON.stringify({version: 1, apiKey: API_KEY, keyId: 'rpk_other', merchant: MERCHANT}))
    expect(() => readCredentials(env)).toThrow('reactiv logout')
    try {
      readCredentials(env)
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET)
    }
  })
})
