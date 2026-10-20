import {execFileSync} from 'node:child_process'
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {API_KEY, assertNoSecrets, isolatedEnv, MERCHANT, meResponse, runCli, startMockVending, tokenResponse, type CliResult} from './helpers/fixtures'
import {buildTemplateTarball, installNpmShim, type NpmShim} from './helpers/npm-shim'

const TRANSCRIPT = process.env.REACTIV_UPGRADE_TRANSCRIPT

const A = '2608.13.1'
const B = '2610.9.3'
const PEERS = {
  [A]: {react: '19.2.3', 'react-native': '0.86.0'},
  [B]: {react: '19.2.4', 'react-native': '0.87.1'},
}
const METRO_B = "module.exports = require('@reactivapp/mobile/toolchain/metro')(__dirname, {platform: 'ios'});\n"

describe('app upgrade against a mock vending API and a fixture registry', () => {
  let workDir: string
  let shim: NpmShim
  let mock: Awaited<ReturnType<typeof startMockVending>>
  let env: NodeJS.ProcessEnv
  let project: string
  const transcript: string[] = []

  const flat = (text: string): string => text.replace(/\s*›\s*/g, ' ').replace(/\s+/g, ' ')
  const git = (args: string[]): string => execFileSync('git', args, {cwd: project, encoding: 'utf8', env}).trim()
  const manifest = (file: string): Record<string, Record<string, string>> => JSON.parse(readFileSync(join(project, file), 'utf8'))
  const trioOf = (section: Record<string, string>) => ({
    '@reactivapp/mobile': section['@reactivapp/mobile'],
    react: section.react,
    'react-native': section['react-native'],
  })
  const npmCalls = (): string[] => readFileSync(shim.log, 'utf8').split('\n').filter(Boolean)
  const clearNpmLog = (): void => writeFileSync(shim.log, '')

  const publish = (latest: string, templateOptions: Parameters<typeof buildTemplateTarball>[1] = {}): void => {
    const templateDir = join(workDir, `tpl-${latest}-${Object.keys(templateOptions.delegations ?? {}).length}`)
    mkdirSync(templateDir, {recursive: true})
    env = {
      ...env,
      FAKE_MOBILE_LATEST: latest,
      FAKE_MOBILE_VERSIONS: JSON.stringify([A, B]),
      FAKE_TEMPLATE_TGZ: buildTemplateTarball(templateDir, templateOptions),
    }
  }

  const step = async (title: string, args: string[], options: {env?: NodeJS.ProcessEnv} = {}): Promise<CliResult> => {
    const result = await runCli(args, {cwd: project, env: options.env ?? env})
    transcript.push(`$ reactiv ${args.join(' ')}`, `# ${title}`, result.stdout.trimEnd())
    if (result.stderr.trim()) transcript.push(result.stderr.trimEnd())
    transcript.push(`(exit ${result.code})`, '')
    assertNoSecrets(result.stdout, result.stderr)
    return result
  }

  const upgrade = (args: string[] = [], title = 'upgrade'): Promise<CliResult> => step(title, ['app', 'upgrade', ...args])

  beforeEach(async () => {
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'upgrade-')))
    shim = installNpmShim(workDir)
    mock = await startMockVending({
      'GET /v1/me': () => ({status: 200, body: meResponse()}),
      'POST /v1/tokens': () => ({status: 200, body: tokenResponse()}),
    })
    env = isolatedEnv(join(workDir, 'home'), {
      ...shim.env,
      REACTIV_VENDING_API_URL: mock.url,
      REACTIV_API_KEY: API_KEY,
      FAKE_MOBILE_PEERS: JSON.stringify(PEERS),
    })
    publish(A)
    transcript.length = 0
    project = workDir
    const init = await step(`scaffold at ${A}`, ['app', 'init', '--app-uuid', MERCHANT.appUuid, '--path', workDir])
    expect(init.code).toBe(0)
    project = join(workDir, 'acme')
    clearNpmLog()
  }, 60_000)

  afterEach(async () => {
    if (TRANSCRIPT) writeFileSync(TRANSCRIPT, transcript.join('\n'), {flag: 'a'})
    await mock.close()
    rmSync(workDir, {recursive: true, force: true})
  })

  it('moves both manifests to the version init would install, reinstalls, prints the pod step, then typechecks', async () => {
    publish(B)
    const result = await upgrade([], `upgrade to the registry's current platform (${B})`)
    expect(result.code).toBe(0)
    const expected = {'@reactivapp/mobile': B, ...PEERS[B]}
    expect(trioOf(manifest('package.json').peerDependencies)).toEqual(expected)
    expect(trioOf(manifest('package.json').devDependencies)).toEqual(expected)
    expect(trioOf(manifest('app/package.json').dependencies)).toEqual(expected)

    const calls = npmCalls()
    expect(calls.filter(call => call.startsWith('view @reactivapp/mobile versions'))).toEqual([])
    expect(calls.map(call => call.split(' --')[0])).toEqual([
      'view @reactivapp/mobile version',
      `view @reactivapp/mobile@${B} peerDependencies`,
      'pack @reactivapp/app-template',
      'install',
      'install',
      'run typecheck',
    ])
    for (const lookup of calls.slice(0, 3)) expect(lookup).toMatch(/--@reactivapp:registry=https:\/\//)
    for (const install of calls.filter(call => call.startsWith('install '))) expect(install).toContain('--ignore-scripts')

    const out = flat(result.stdout)
    expect(out.indexOf('Native step (the CLI does not run it): cd app/ios && pod install')).toBeGreaterThan(-1)
    expect(out.indexOf('cd app/ios && pod install')).toBeLessThan(out.indexOf('Running the project typecheck'))
    expect(out).toContain(`typecheck clean against @reactivapp/mobile@${B}`)
    expect(out).toContain(`roll back with: reactiv app upgrade --to ${A}`)
    expect(readFileSync(join(project, 'app', 'node_modules', 'react-native', 'package.json'), 'utf8')).toContain(PEERS[B]['react-native'])
  }, 60_000)

  it('leaves src/, developer files and toolchain delegations untouched, printing the exact replacement instead', async () => {
    writeFileSync(join(project, 'src', 'index.ts'), "export const mine = 'developer code';\n")
    writeFileSync(join(project, 'app', 'babel.config.js'), "module.exports = {presets: ['my-own-preset']};\n")
    git(['add', '-A'])
    git(['commit', '--quiet', '-m', 'developer edits'])
    publish(B, {delegations: {'app/metro.config.js': METRO_B}})

    const result = await upgrade([], 'upgrade with a template whose metro delegation changed and a developer-edited babel config')
    expect(result.code).toBe(0)
    expect(git(['ls-files', '--others', '--exclude-standard'])).toBe('')
    const changed = git(['diff', '--name-only', 'HEAD']).split('\n').sort()
    expect(changed).toEqual(['app/package-lock.json', 'app/package.json', 'package-lock.json', 'package.json'])
    expect(readFileSync(join(project, 'src', 'index.ts'), 'utf8')).toBe("export const mine = 'developer code';\n")
    expect(readFileSync(join(project, 'app', 'babel.config.js'), 'utf8')).toBe("module.exports = {presets: ['my-own-preset']};\n")

    expect(result.stdout).toContain(`app/metro.config.js: replace its entire content with:\n----- app/metro.config.js -----\n${METRO_B}----- end app/metro.config.js -----`)
    expect(result.stdout).toContain("----- app/babel.config.js -----\nmodule.exports = {presets: [require('@reactivapp/mobile/toolchain/babel-preset')]};\n")
    expect(result.stdout).not.toContain('----- tsconfig.json -----')
    expect(result.stdout).not.toContain('----- app/ios/Podfile -----')
  }, 60_000)

  it('rewrites nothing on a second run and still reinstalls and typechecks', async () => {
    publish(B)
    expect((await upgrade()).code).toBe(0)
    const before = [readFileSync(join(project, 'package.json'), 'utf8'), readFileSync(join(project, 'app', 'package.json'), 'utf8')]
    clearNpmLog()
    const again = await upgrade([], 'second run: already on the target')
    expect(again.code).toBe(0)
    expect(again.stdout).toContain(`already declare @reactivapp/mobile@${B}`)
    expect([readFileSync(join(project, 'package.json'), 'utf8'), readFileSync(join(project, 'app', 'package.json'), 'utf8')]).toEqual(before)
    expect(npmCalls().filter(call => call.startsWith('install ') || call.startsWith('run typecheck'))).toHaveLength(3)
  }, 60_000)

  it('keeps a failed upgrade applied, reports the typecheck errors and prints the one-command rollback that works', async () => {
    publish(B)
    env = {...env, FAKE_TYPECHECK_FAIL_ON: B}
    const failed = await upgrade([], `upgrade to ${B}, whose typecheck fails`)
    expect(failed.code).not.toBe(0)
    expect(failed.stdout).toContain("error TS2305: Module '@reactivapp/mobile' has no exported member 'registerSection'.")
    expect(failed.errorText).toContain('npm run typecheck exited with 2')
    expect(failed.errorText).toContain(`roll back with: reactiv app upgrade --to ${A}`)
    expect(trioOf(manifest('app/package.json').dependencies)).toEqual({'@reactivapp/mobile': B, ...PEERS[B]})

    const rolledBack = await upgrade(['--to', A], 'run the printed rollback')
    expect(rolledBack.code).toBe(0)
    expect(rolledBack.stderr).toContain(`moving back from ${B} to the older ${A}`)
    expect(trioOf(manifest('package.json').peerDependencies)).toEqual({'@reactivapp/mobile': A, ...PEERS[A]})
    expect(trioOf(manifest('package.json').devDependencies)).toEqual({'@reactivapp/mobile': A, ...PEERS[A]})
    expect(trioOf(manifest('app/package.json').dependencies)).toEqual({'@reactivapp/mobile': A, ...PEERS[A]})
    expect(git(['status', '--porcelain'])).toBe('')
  }, 60_000)

  it('adds the trio to devDependencies of a project scaffolded before the template carried it, keeping the rest', async () => {
    const library = manifest('package.json')
    writeFileSync(join(project, 'package.json'), `${JSON.stringify({...library, devDependencies: {typescript: '~5.8.3'}})}\n`)
    publish(B)
    expect((await upgrade()).code).toBe(0)
    expect(manifest('package.json').devDependencies).toEqual({typescript: '~5.8.3', '@reactivapp/mobile': B, ...PEERS[B]})
    expect(trioOf(manifest('package.json').peerDependencies)).toEqual({'@reactivapp/mobile': B, ...PEERS[B]})
  }, 60_000)

  it('reports dependency drift the post-install check finds, with the rollback, keeping the change', async () => {
    const library = manifest('package.json')
    writeFileSync(join(project, 'package.json'), `${JSON.stringify({...library, dependencies: {'date-fns': '4.1.0'}})}\n`)
    git(['commit', '--quiet', '-am', 'library dependency not mirrored in app/'])
    publish(B)
    const result = await upgrade([], 'upgrade a project whose app/ does not mirror the library')
    expect(result.code).not.toBe(0)
    const error = flat(result.errorText)
    expect(error).toContain('date-fns: missing from app/package.json — add "date-fns": "4.1.0" to its dependencies')
    expect(error).toContain(`roll back with: reactiv app upgrade --to ${A}`)
    expect(manifest('app/package.json').dependencies['@reactivapp/mobile']).toBe(B)
    expect(manifest('package.json').dependencies).toEqual({'date-fns': '4.1.0'})
  }, 60_000)

  it('refuses a platform release whose react/react-native peers are not exact versions', async () => {
    publish(B)
    env = {...env, FAKE_MOBILE_PEERS: JSON.stringify({...PEERS, [B]: {react: '^19.2.4', 'react-native': '0.87.1'}})}
    const result = await upgrade()
    expect(result.code).not.toBe(0)
    expect(flat(result.errorText)).toContain(`@reactivapp/mobile@${B} pins react "^19.2.4" and react-native "0.87.1", which are not exact versions; nothing changed`)
    expect(git(['status', '--porcelain'])).toBe('')
  }, 60_000)

  it('needs --to when app/package.json declares the platform as a range', async () => {
    const appManifest = manifest('app/package.json')
    writeFileSync(join(project, 'app', 'package.json'), `${JSON.stringify({...appManifest, dependencies: {...appManifest.dependencies, '@reactivapp/mobile': `^${A}`}})}\n`)
    git(['commit', '--quiet', '-am', 'range'])
    publish(B)
    const refused = await upgrade()
    expect(refused.code).not.toBe(0)
    expect(flat(refused.errorText)).toContain(`declares @reactivapp/mobile "^${A}", not an exact version`)
    expect(npmCalls()).toEqual([])

    const named = await upgrade(['--to', B])
    expect(named.code).toBe(0)
    expect(flat(named.stdout)).toContain('roll back with: restore package.json, app/package.json and both')
    expect(trioOf(manifest('app/package.json').dependencies)).toEqual({'@reactivapp/mobile': B, ...PEERS[B]})
  }, 60_000)

  it('prints the rollback when an install fails even though the manifests already match the target', async () => {
    publish(B)
    expect((await upgrade()).code).toBe(0)
    git(['commit', '--quiet', '-am', `platform ${B}`])
    env = {...env, FAKE_NPM_E401_ALWAYS_VERB: 'install'}
    const result = await upgrade(['--to', B], 'reinstall that the registry rejects')
    expect(result.code).not.toBe(0)
    expect(flat(result.stderr)).toContain(`to roll back: reactiv app upgrade --to ${B}`)
  }, 60_000)

  it('keeps the manifests\' file mode when it rewrites them', async () => {
    chmodSync(join(project, 'package.json'), 0o644)
    chmodSync(join(project, 'app', 'package.json'), 0o664)
    publish(B)
    expect((await upgrade()).code).toBe(0)
    expect(statSync(join(project, 'package.json')).mode & 0o777).toBe(0o644)
    expect(statSync(join(project, 'app', 'package.json')).mode & 0o777).toBe(0o664)
  }, 60_000)

  it('names both values when the manifests disagree on the platform, rolling back to the app value', async () => {
    const library = manifest('package.json')
    writeFileSync(join(project, 'package.json'), `${JSON.stringify({...library, peerDependencies: {...library.peerDependencies, '@reactivapp/mobile': '2607.1.1'}})}\n`)
    publish(B)
    const result = await upgrade()
    expect(result.code).toBe(0)
    expect(flat(result.stdout.replace(/[│╭╮╰╯─]/g, ' '))).toContain(`this project is on @reactivapp/mobile@${A} in app/package.json, but package.json peerDependencies declare 2607.1.1 — the rollback restores ${A} into both`)
    expect(flat(result.stdout)).toContain(`roll back with: reactiv app upgrade --to ${A}`)
  }, 60_000)

  it('refuses unreadable registry output with a login hint instead of a parse error', async () => {
    publish(B)
    env = {...env, FAKE_MOBILE_VERSIONS: 'npm notice something odd'}
    const result = await upgrade(['--to', B])
    expect(result.code).not.toBe(0)
    expect(flat(result.errorText)).toContain('npm view @reactivapp/mobile versions --json returned unreadable output — run `reactiv whoami`')
    expect(result.stderr).not.toContain('SyntaxError')
    expect(git(['status', '--porcelain'])).toBe('')
  }, 60_000)

  it('refuses a current version that does not read as a version, and an empty version list', async () => {
    publish('<html>')
    const latest = await upgrade()
    expect(latest.code).not.toBe(0)
    expect(flat(latest.errorText)).toContain('npm view @reactivapp/mobile version returned unreadable output')
    publish(B)
    env = {...env, FAKE_MOBILE_VERSIONS: ''}
    const list = await upgrade(['--to', B])
    expect(list.code).not.toBe(0)
    expect(flat(list.errorText)).toContain('npm view @reactivapp/mobile versions --json returned unreadable output')
    expect(git(['status', '--porcelain'])).toBe('')
  }, 60_000)

  it('validates --to against the published versions and changes nothing for an unknown one', async () => {
    publish(B)
    const result = await upgrade(['--to', '2611.1.1'], 'unknown --to')
    expect(result.code).not.toBe(0)
    expect(flat(result.errorText)).toContain(`@reactivapp/mobile@2611.1.1 is not available to you — recent versions: ${A}, ${B}`)
    expect(npmCalls().map(call => call.split(' --')[0])).toEqual(['view @reactivapp/mobile versions'])
    expect(git(['status', '--porcelain'])).toBe('')

    const loose = await upgrade(['--to', '^2610.0.0'], 'range --to')
    expect(loose.code).not.toBe(0)
    expect(flat(loose.errorText)).toContain('--to takes an exact version')
  }, 60_000)

  it('refuses a default that would move the project to an older platform', async () => {
    publish(B)
    expect((await upgrade(['--to', B])).code).toBe(0)
    git(['commit', '--quiet', '-am', `platform ${B}`])
    publish(A)
    clearNpmLog()
    const result = await upgrade([], 'registry current is older than the project')
    expect(result.code).not.toBe(0)
    expect(flat(result.errorText)).toContain(`the newest @reactivapp/mobile available to you (${A}) is older than this project's ${B}; nothing changed — pass --to ${A}`)
    expect(npmCalls().some(call => call.startsWith('install '))).toBe(false)
    expect(git(['status', '--porcelain'])).toBe('')
  }, 60_000)
})
