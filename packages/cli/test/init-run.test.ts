import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {delimiter, join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {BLOCK_START} from '../src/lib/auth/npmrc'
import {API_KEY, isolatedEnv, MERCHANT, meResponse, runCli, startMockVending, tokenResponse} from './helpers/fixtures'
import {buildTemplateTarball, installNpmShim, type NpmShim} from './helpers/npm-shim'

const POD_SHIM = `#!/bin/sh
printf '%s|%s\\n' "$PWD" "$*" >> "$FAKE_POD_LOG"
exit 1
`

describe('app init and app run on the library layout', () => {
  let workDir: string
  let shim: NpmShim
  let podLog: string
  let mock: Awaited<ReturnType<typeof startMockVending>>
  let env: NodeJS.ProcessEnv

  const setup = async (templateOptions: Parameters<typeof buildTemplateTarball>[1] = {}): Promise<void> => {
    const templateDir = join(workDir, `tpl-${templateOptions.legacyLayout ? 'legacy' : 'library'}`)
    mkdirSync(templateDir, {recursive: true})
    shim = installNpmShim(workDir, buildTemplateTarball(templateDir, templateOptions))
    writeFileSync(join(shim.binDir, 'pod'), POD_SHIM)
    chmodSync(join(shim.binDir, 'pod'), 0o755)
    env = isolatedEnv(join(workDir, 'home'), {
      ...shim.env,
      PATH: `${shim.binDir}${delimiter}${process.env.PATH ?? ''}`,
      REACTIV_VENDING_API_URL: mock.url,
      REACTIV_API_KEY: API_KEY,
      FAKE_POD_LOG: podLog,
    })
  }

  beforeEach(async () => {
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'init-run-')))
    podLog = join(workDir, 'pod.log')
    writeFileSync(podLog, '')
    mock = await startMockVending({
      'GET /v1/me': () => ({status: 200, body: meResponse()}),
      'POST /v1/tokens': () => ({status: 200, body: tokenResponse()}),
    })
    await setup()
  })

  afterEach(async () => {
    await mock.close()
    rmSync(workDir, {recursive: true, force: true})
  })

  // oclif wraps long error lines behind a ' ›' gutter; join them back up.
  const flat = (text: string): string => text.replace(/\s*›\s*/g, ' ').replace(/\s+/g, ' ')

  const init = () =>
    runCli(['app', 'init', '--app-uuid', MERCHANT.appUuid, '--path', workDir], {cwd: workDir, env})

  const installs = (): string[] =>
    readFileSync(shim.log, 'utf8').split('\n').filter(line => line.startsWith('install '))

  it('takes the folder, package name, app name and app UUID from the login, asking nothing', async () => {
    const result = await runCli(['app', 'init', '--path', workDir], {cwd: workDir, env})
    expect(result.code).toBe(0)
    const project = join(workDir, 'acme')
    expect(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).name).toBe('acme')
    const conf = readFileSync(join(project, 'reactiv.conf.js'), 'utf8')
    expect(conf).toContain(`appUuid: '${MERCHANT.appUuid}'`)
    expect(conf).toContain("appName: 'acme'")
    expect(result.stdout).toContain('cd acme')
  })

  it('refuses a merchant slug that is not a plain name, before touching the file system', async () => {
    await mock.close()
    mock = await startMockVending({
      'GET /v1/me': () => ({status: 200, body: meResponse({merchant: {...MERCHANT, slug: '../outside'}})}),
      'POST /v1/tokens': () => ({status: 200, body: tokenResponse({merchant: {...MERCHANT, slug: '../outside'}})}),
    })
    env = {...env, REACTIV_VENDING_API_URL: mock.url}
    const result = await runCli(['app', 'init', '--path', workDir], {cwd: workDir, env})
    expect(result.code).not.toBe(0)
    expect(flat(result.errorText)).toContain('is not a plain lowercase name')
    expect(existsSync(join(workDir, '..', 'outside'))).toBe(false)
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toEqual([])
  })

  it('refuses an --app-uuid that is not the app the login is provisioned for', async () => {
    const result = await runCli(['app', 'init', '--app-uuid', '11111111-1111-1111-1111-111111111111', '--path', workDir], {cwd: workDir, env})
    expect(result.code).not.toBe(0)
    expect(flat(result.stderr)).toContain('is not the app your login is provisioned for')
    expect(existsSync(join(workDir, 'acme'))).toBe(false)
  })

  it('scaffolds the library at the root and the shell in app/, then installs both behind the managed block', async () => {
    const result = await init()
    expect(result.code).toBe(0)
    const project = join(workDir, 'acme')
    expect(existsSync(join(project, 'src', 'index.ts'))).toBe(true)
    expect(readFileSync(join(project, 'app', 'index.js'), 'utf8')).toBe("import 'acme';\n")
    for (const npmrc of [join(project, '.npmrc'), join(project, 'app', '.npmrc')]) {
      expect(readFileSync(npmrc, 'utf8')).toContain(BLOCK_START)
      expect(readFileSync(npmrc, 'utf8')).not.toContain('CODEARTIFACT_AUTH_TOKEN')
    }
    expect(installs()).toEqual([
      'install --no-audit --no-fund --ignore-scripts --loglevel notice',
      'install --no-audit --no-fund --ignore-scripts --loglevel notice',
    ])
  }, 60_000)

  it('refuses a template that predates the library layout and removes the partial project', async () => {
    await setup({legacyLayout: true})
    const result = await init()
    expect(result.code).not.toBe(0)
    expect(flat(result.errorText)).toContain('predates the library layout')
    expect(existsSync(join(workDir, 'acme'))).toBe(false)
    expect(installs()).toEqual([])
  }, 60_000)

  it.each([
    ['react-native', 'the platform already uses'],
    ['typescript', 'the project itself installs'],
    ['metro', 'the project itself installs'],
  ])('refuses the merchant slug %s, whose package name would shadow a package', async (slug, reason) => {
    // The slug comes from the login, so the mock merchant has to carry it.
    await mock.close()
    mock = await startMockVending({
      'GET /v1/me': () => ({status: 200, body: meResponse({merchant: {...MERCHANT, slug}, label: `${slug}/jane.doe`})}),
      'POST /v1/tokens': () => ({status: 200, body: tokenResponse({merchant: {...MERCHANT, slug}})}),
    })
    env = {...env, REACTIV_VENDING_API_URL: mock.url}
    const result = await init()
    expect(result.code).not.toBe(0)
    expect(flat(result.errorText)).toContain(reason)
    expect(existsSync(join(workDir, slug))).toBe(false)
  }, 60_000)

  it('runs pod install inside app/ios when the shell mirrors the library', async () => {
    expect((await init()).code).toBe(0)
    await runCli(['app', 'run', 'ios'], {cwd: join(workDir, 'acme'), env})
    expect(readFileSync(podLog, 'utf8').trim()).toMatch(/\/acme\/app\/ios\|install$/)
  }, 60_000)

  it('stops before any build step with the exact fix when the shell does not mirror the library', async () => {
    expect((await init()).code).toBe(0)
    const project = join(workDir, 'acme')
    const manifestPath = join(project, 'package.json')
    const library = JSON.parse(readFileSync(manifestPath, 'utf8'))
    writeFileSync(manifestPath, JSON.stringify({...library, dependencies: {'date-fns': '4.1.0'}}))
    const result = await runCli(['app', 'run', 'ios'], {cwd: project, env})
    expect(result.code).not.toBe(0)
    expect(flat(result.errorText)).toContain('date-fns: missing from app/package.json — add "date-fns": "4.1.0" to its dependencies')
    expect(readFileSync(podLog, 'utf8')).toBe('')
  }, 60_000)
})
