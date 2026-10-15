import {execFileSync, spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {BLOCK_START} from '../src/lib/auth/npmrc'
import {
  API_KEY,
  assertNoSecrets,
  isolatedEnv,
  MERCHANT,
  meResponse,
  OTHER_TOKEN,
  REGISTRY_URL,
  runCli,
  startMockVending,
  TOKEN,
  tokenResponse,
  TOOLS_REGISTRY_URL,
  type CliResult,
  type MockReply,
} from './helpers/fixtures'
import {buildTemplateTarball, installNpmShim, type NpmShim} from './helpers/npm-shim'

// Set REACTIV_WALKTHROUGH_TRANSCRIPT=<file> to keep a readable transcript of the run.
const TRANSCRIPT = process.env.REACTIV_WALKTHROUGH_TRANSCRIPT

describe('scripted walkthrough against a mock vending API: login → app init → app submit --dry-run', () => {
  let workDir: string
  let home: string
  let shim: NpmShim
  let mock: Awaited<ReturnType<typeof startMockVending>>
  let tokenReplies: MockReply[]
  let env: NodeJS.ProcessEnv
  const transcript: string[] = []

  const step = async (title: string, args: string[], options: {cwd: string; input?: string; env?: NodeJS.ProcessEnv}): Promise<CliResult> => {
    const result = await runCli(args, {cwd: options.cwd, env: options.env ?? env, input: options.input})
    transcript.push(`$ reactiv ${args.join(' ')}${options.input ? '   (key piped on stdin)' : ''}`, `# ${title}`, result.stdout.trimEnd())
    if (result.stderr.trim()) transcript.push(result.stderr.trimEnd())
    transcript.push(`(exit ${result.code})`, '')
    assertNoSecrets(result.stdout, result.stderr)
    return result
  }

  beforeEach(async () => {
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'walkthrough-')))
    home = join(workDir, 'home')
    mkdirSync(home)
    shim = installNpmShim(workDir, buildTemplateTarball(workDir))
    tokenReplies = []
    mock = await startMockVending({
      'GET /v1/me': () => ({status: 200, body: meResponse()}),
      'POST /v1/tokens': () => tokenReplies.shift() ?? {status: 200, body: tokenResponse()},
    })
    env = isolatedEnv(home, {...shim.env, REACTIV_VENDING_API_URL: mock.url})
    transcript.length = 0
  })

  afterEach(async () => {
    await mock.close()
    rmSync(workDir, {recursive: true, force: true})
  })

  it('runs end to end with transparent token handling and no AWS step', async () => {
    const login = await step('log in once with the issued key', ['login', '--with-token'], {cwd: workDir, input: `${API_KEY}\n`})
    expect(login.code).toBe(0)

    const init = await step(
      'scaffold: registry lookups through a throwaway user config, then the managed block before npm install',
      ['app', 'init', '--name', 'Acme', '--app-uuid', MERCHANT.appUuid, '--path', workDir],
      {cwd: workDir},
    )
    expect(init.code).toBe(0)
    const project = join(workDir, 'acme')
    const npmrc = readFileSync(join(project, '.npmrc'), 'utf8')
    expect(npmrc).toContain(BLOCK_START)
    expect(npmrc).not.toContain('CODEARTIFACT_AUTH_TOKEN')
    expect(statSync(join(project, '.npmrc')).mode & 0o777).toBe(0o600)

    const ignored = execFileSync('git', ['check-ignore', '-v', '.npmrc'], {cwd: project, encoding: 'utf8'}).trim()
    expect(ignored).toMatch(/\.gitignore:\d+:\.npmrc\s+\.npmrc/)
    const committed = execFileSync('git', ['ls-files'], {cwd: project, encoding: 'utf8'})
    expect(committed.split('\n')).not.toContain('.npmrc')
    expect(execFileSync('git', ['log', '-p', '--all'], {cwd: project, encoding: 'utf8'})).not.toContain(TOKEN)
    transcript.push(
      '$ git check-ignore -v .npmrc', ignored,
      '$ git ls-files | grep -c npmrc', String(committed.split('\n').filter(file => file.endsWith('.npmrc')).length),
      '$ cat .npmrc   (token replaced with <token> for the transcript)', npmrc.replaceAll(TOKEN, '<token>').trimEnd(), '',
    )

    const submit = await step('submit dry run: registry and token come from the vending response', ['app', 'submit', '--dry-run'], {cwd: project})
    expect(submit.code).toBe(0)
    expect(submit.stdout).toContain('Dry run complete (publish skipped)')
    expect(submit.stdout).toContain('@reactiv-submissions/acme@0.1.0-draft.1')

    const whoami = await step('identity and cache state', ['whoami'], {cwd: project})
    expect(whoami.stdout).toContain('Token cache:   valid until')

    const logout = await step('log out: key and cache first, then the project block', ['logout'], {cwd: project})
    expect(logout.code).toBe(0)
    expect(readFileSync(join(project, '.npmrc'), 'utf8')).not.toContain(BLOCK_START)

    const tokenCalls = mock.requests.filter(request => request.path === '/v1/tokens')
    expect(tokenCalls).toHaveLength(1)
    const npmLog = readFileSync(shim.log, 'utf8')
    assertNoSecrets(npmLog)
    expect(npmLog).toMatch(/^view @reactivapp\/mobile version --@reactivapp:registry=https:\S+\/npm\/tools\/ --loglevel notice$/m)
    expect(npmLog).toMatch(/^pack @reactivapp\/app-template --pack-destination \S+ --ignore-scripts --@reactivapp:registry=\S+ --loglevel http$/m)
    expect(npmLog).toMatch(/^install --no-audit --no-fund --ignore-scripts --loglevel notice$/m)
    expect(npmLog).not.toMatch(/aws |codeartifact get-authorization-token|CODEARTIFACT_AUTH_TOKEN/)
    transcript.push(`# vending calls: ${mock.requests.map(request => `${request.method} ${request.path}`).join(', ')}`, '# npm calls (recorded by the shim):', npmLog.trimEnd())

    if (TRANSCRIPT) writeFileSync(TRANSCRIPT, transcript.join('\n') + '\n')
  }, 120_000)

  it('heals an E401 during init with one re-mint', async () => {
    await runCli(['login', '--with-token'], {cwd: workDir, env, input: `${API_KEY}\n`})
    tokenReplies.push({status: 200, body: tokenResponse()}, {status: 200, body: tokenResponse({token: OTHER_TOKEN})})
    const init = await runCli(['app', 'init', '--name', 'Acme', '--app-uuid', MERCHANT.appUuid, '--path', workDir, '--skip-install'], {
      cwd: workDir,
      env: {...env, FAKE_NPM_E401_ONCE: join(workDir, 'e401-done')},
    })
    expect(init.code).toBe(0)
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toHaveLength(2)
    expect(readFileSync(join(workDir, 'acme', '.npmrc'), 'utf8')).toContain(OTHER_TOKEN)
    assertNoSecrets(init.stdout, init.stderr)
  }, 60_000)

  it('spends at most one re-mint per init across the platform lookup and the template download', async () => {
    await runCli(['login', '--with-token'], {cwd: workDir, env, input: `${API_KEY}\n`})
    const init = await runCli(['app', 'init', '--name', 'Acme', '--app-uuid', MERCHANT.appUuid, '--path', workDir, '--skip-install'], {
      cwd: workDir,
      env: {...env, FAKE_NPM_E401_ONCE: join(workDir, 'e401-done'), FAKE_NPM_E401_ONCE_VERB: 'view', FAKE_NPM_E401_ALWAYS_VERB: 'pack'},
    })
    expect(init.code).not.toBe(0)
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toHaveLength(2)
    expect(existsSync(join(workDir, 'acme'))).toBe(false)
    assertNoSecrets(init.stdout, init.stderr)
  }, 60_000)

  it.each([
    ['the template download', 'pack'],
    ['the dependency install', 'install'],
  ])('stops instead of mixing registries when a refresh during %s moves the tools registry', async (_, verb) => {
    await runCli(['login', '--with-token'], {cwd: workDir, env, input: `${API_KEY}\n`})
    const moved = TOOLS_REGISTRY_URL.replace('/tools/', '/tools-moved/')
    tokenReplies.push({status: 200, body: tokenResponse()}, {status: 200, body: tokenResponse({toolsRegistryUrl: moved})})
    const init = await runCli(['app', 'init', '--name', 'Acme', '--app-uuid', MERCHANT.appUuid, '--path', workDir], {
      cwd: workDir,
      env: {...env, FAKE_NPM_E401_ONCE: join(workDir, 'e401-done'), FAKE_NPM_E401_ONCE_VERB: verb},
    })
    expect(init.code).not.toBe(0)
    expect(init.errorText).toContain('The Reactiv tools registry changed while setting up the project; nothing was scaffolded from mixed sources. Run `reactiv app init` again.')
    expect(existsSync(join(workDir, 'acme'))).toBe(false)
    expect(readFileSync(shim.log, 'utf8')).not.toContain(moved)
    assertNoSecrets(init.stdout, init.stderr)
  }, 60_000)

  it('retries the first lookup against a moved tools registry when nothing came from the old one yet', async () => {
    await runCli(['login', '--with-token'], {cwd: workDir, env, input: `${API_KEY}\n`})
    const moved = TOOLS_REGISTRY_URL.replace('/tools/', '/tools-moved/')
    tokenReplies.push({status: 200, body: tokenResponse()}, {status: 200, body: tokenResponse({toolsRegistryUrl: moved})})
    const init = await runCli(['app', 'init', '--name', 'Acme', '--app-uuid', MERCHANT.appUuid, '--path', workDir, '--skip-install'], {
      cwd: workDir,
      env: {...env, FAKE_NPM_E401_ONCE: join(workDir, 'e401-done'), FAKE_NPM_E401_ONCE_VERB: 'view'},
    })
    expect(init.code).toBe(0)
    const registryCalls = readFileSync(shim.log, 'utf8').split('\n').filter(line => /^(view|pack) @reactivapp/.test(line))
    expect(registryCalls[0]).toContain(TOOLS_REGISTRY_URL)
    for (const call of registryCalls.slice(1)) expect(call).toContain(`--@reactivapp:registry=${moved} `)
  }, 60_000)

  it('refuses to install from a registry other than the one the template came from', async () => {
    await runCli(['login', '--with-token'], {cwd: workDir, env, input: `${API_KEY}\n`})
    const moved = TOOLS_REGISTRY_URL.replace('/tools/', '/tools-moved/')
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    tokenReplies.push({status: 200, body: tokenResponse({expiresAt: soon})}, {status: 200, body: tokenResponse({toolsRegistryUrl: moved})})
    const init = await runCli(['app', 'init', '--name', 'Acme', '--app-uuid', MERCHANT.appUuid, '--path', workDir], {cwd: workDir, env})
    expect(init.code).not.toBe(0)
    expect(init.errorText).toContain('The Reactiv tools registry changed while setting up the project; nothing was scaffolded from mixed sources. Run `reactiv app init` again.')
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toHaveLength(2)
    expect(readFileSync(shim.log, 'utf8').split('\n').filter(line => line.startsWith('install '))).toEqual([])
    expect(existsSync(join(workDir, 'acme'))).toBe(false)
  }, 60_000)

  it('refuses when only the submissions registry moved between the template download and the scaffold token', async () => {
    await runCli(['login', '--with-token'], {cwd: workDir, env, input: `${API_KEY}\n`})
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    const moved = REGISTRY_URL.replace('submissions-acme/', 'submissions-acme-moved/')
    tokenReplies.push({status: 200, body: tokenResponse({expiresAt: soon})}, {status: 200, body: tokenResponse({registryUrl: moved})})
    const init = await runCli(['app', 'init', '--name', 'Acme', '--app-uuid', MERCHANT.appUuid, '--path', workDir], {cwd: workDir, env})
    expect(init.code).not.toBe(0)
    expect(init.errorText).toContain('The Reactiv submissions registry changed while setting up the project; nothing was scaffolded from mixed sources.')
    expect(readFileSync(shim.log, 'utf8').split('\n').filter(line => line.startsWith('install '))).toEqual([])
    expect(existsSync(join(workDir, 'acme'))).toBe(false)
  }, 60_000)

  it('names both registries when both moved', async () => {
    await runCli(['login', '--with-token'], {cwd: workDir, env, input: `${API_KEY}\n`})
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    tokenReplies.push(
      {status: 200, body: tokenResponse({expiresAt: soon})},
      {
        status: 200,
        body: tokenResponse({
          registryUrl: REGISTRY_URL.replace('submissions-acme/', 'submissions-acme-moved/'),
          toolsRegistryUrl: TOOLS_REGISTRY_URL.replace('/tools/', '/tools-moved/'),
        }),
      },
    )
    const init = await runCli(['app', 'init', '--name', 'Acme', '--app-uuid', MERCHANT.appUuid, '--path', workDir], {cwd: workDir, env})
    expect(init.code).not.toBe(0)
    expect(init.errorText).toContain('The Reactiv tools and submissions registries changed while setting up the project')
  }, 60_000)

  it('removes what a failed run created inside a pre-existing empty directory, keeping the directory', async () => {
    await runCli(['login', '--with-token'], {cwd: workDir, env, input: `${API_KEY}\n`})
    const project = join(workDir, 'acme')
    mkdirSync(project)
    const init = await runCli(['app', 'init', '--name', 'Acme', '--app-uuid', MERCHANT.appUuid, '--path', workDir], {
      cwd: workDir,
      env: {...env, FAKE_NPM_E401_ALWAYS_VERB: 'install'},
    })
    expect(init.code).not.toBe(0)
    expect(existsSync(project)).toBe(true)
    expect(existsSync(join(project, '.npmrc'))).toBe(false)
    expect(existsSync(join(project, 'app', '.npmrc'))).toBe(false)
    expect(readdirSync(project)).toEqual([])
    expect(init.stderr).toContain('removed what this run created')
  }, 60_000)

  it('removes a root .npmrc that login created when the template ships none', async () => {
    shim = installNpmShim(workDir, buildTemplateTarball(join(workDir, 'no-npmrc'), {omitRootNpmrc: true}))
    env = {...env, ...shim.env}
    await runCli(['login', '--with-token'], {cwd: workDir, env, input: `${API_KEY}\n`})
    const project = join(workDir, 'acme')
    mkdirSync(project)
    const init = await runCli(['app', 'init', '--name', 'Acme', '--app-uuid', MERCHANT.appUuid, '--path', workDir], {
      cwd: workDir,
      env: {...env, FAKE_NPM_E401_ALWAYS_VERB: 'install'},
    })
    expect(init.code).not.toBe(0)
    expect(existsSync(join(project, '.npmrc'))).toBe(false)
    expect(readdirSync(project)).toEqual([])
  }, 60_000)

  it('refuses to scaffold another merchant’s app before minting anything', async () => {
    await runCli(['login', '--with-token'], {cwd: workDir, env, input: `${API_KEY}\n`})
    const init = await runCli(['app', 'init', '--name', 'Globex', '--app-uuid', '11111111-1111-1111-1111-111111111111', '--path', workDir], {cwd: workDir, env})
    expect(init.code).not.toBe(0)
    expect(init.errorText).toContain(`Logged in as acme (${MERCHANT.appUuid}), but this project belongs to globex`)
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toEqual([])
    expect(existsSync(join(workDir, 'globex'))).toBe(false)
  }, 60_000)

  it('refuses to write a token into a scaffold whose .gitignore does not cover .npmrc', async () => {
    shim = installNpmShim(workDir, buildTemplateTarball(join(workDir, 'bad'), {gitignore: 'node_modules/\n'}))
    env = {...env, ...shim.env}
    await runCli(['login', '--with-token'], {cwd: workDir, env, input: `${API_KEY}\n`})
    const init = await runCli(['app', 'init', '--name', 'Acme', '--app-uuid', MERCHANT.appUuid, '--path', workDir], {cwd: workDir, env})
    expect(init.code).not.toBe(0)
    expect(init.errorText).toContain("the scaffold's .gitignore does not ignore .npmrc")
    expect(existsSync(join(workDir, 'acme'))).toBe(false)
  }, 60_000)
})

describe('scaffold gitignore covers both token-bearing .npmrc paths', () => {
  it('git check-ignore accepts the root and app/ .npmrc in a library-first scaffold fixture', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gitignore-')))
    try {
      const template = join(dir, 'tpl')
      mkdirSync(template)
      buildTemplateTarball(template)
      const gitignore = readFileSync(join(template, 'template-src', 'package', 'template', 'gitignore'), 'utf8')
      // No leading slash, so the pattern matches at any depth.
      expect(gitignore.split('\n')).toContain('.npmrc')
      const scaffold = join(dir, 'scaffold')
      mkdirSync(join(scaffold, 'app'), {recursive: true})
      writeFileSync(join(scaffold, '.gitignore'), gitignore)
      writeFileSync(join(scaffold, 'package.json'), '{}')
      writeFileSync(join(scaffold, 'app', 'package.json'), '{}')
      execFileSync('git', ['init', '--quiet'], {cwd: scaffold})
      for (const file of ['.npmrc', 'app/.npmrc']) {
        expect(spawnSync('git', ['check-ignore', '-q', file], {cwd: scaffold}).status).toBe(0)
      }
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })
})
