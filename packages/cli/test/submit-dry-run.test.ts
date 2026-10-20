import {execFileSync} from 'node:child_process'
import {linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

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
  tokenResponse,
  type MockReply,
} from './helpers/fixtures'
import {installNpmShim, type NpmShim} from './helpers/npm-shim'
import {SECRET_PATTERNS} from '../src/lib/secret-scan.js'

const PLATFORM_PEERS = {'@reactivapp/mobile': '2608.13.1', react: '19.2.3', 'react-native': '0.86.0'}

const LIBRARY_MANIFEST = {
  workspaces: ['app'],
  name: 'acme',
  version: '0.0.1',
  private: true,
  main: 'src/index.ts',
  'react-native': 'src/index.ts',
  files: ['src'],
  scripts: {typecheck: 'node node_modules/@reactivapp/mobile/toolchain/typecheck.mjs', prepack: 'exit 1'},
  dependencies: {'date-fns': '4.1.0'},
  peerDependencies: PLATFORM_PEERS,
  devDependencies: {typescript: '~5.8.3'},
  publishConfig: {registry: 'https://registry.npmjs.org/'},
}

const APP_MANIFEST = {name: 'acme-app', private: true, dependencies: {...PLATFORM_PEERS}}

const writeInstalled = (appDir: string, name: string, manifest: object): void => {
  mkdirSync(join(appDir, 'node_modules', name), {recursive: true})
  writeFileSync(join(appDir, 'node_modules', name, 'package.json'), JSON.stringify({name, ...manifest}))
}

const writeFixtureProject = (root: string): void => {
  writeFileSync(join(root, 'reactiv.conf.js'), `module.exports = {appUuid: '${MERCHANT.appUuid}', appName: 'Acme'}\n`)
  writeFileSync(join(root, 'package.json'), JSON.stringify(LIBRARY_MANIFEST, null, 2))
  mkdirSync(join(root, 'src', 'customizations'), {recursive: true})
  writeFileSync(
    join(root, 'src', 'index.ts'),
    "export {CustomCompositions} from './customizations/CustomCompositions';\nexport {registerCustomComponents} from './customizations/registerCustomComponents';\n",
  )
  writeFileSync(join(root, 'src', 'customizations', 'CustomCompositions.tsx'), "import {format} from 'date-fns';\nexport const CustomCompositions = {format};\n")
  writeFileSync(join(root, 'src', 'customizations', 'registerCustomComponents.tsx'), 'export function registerCustomComponents() {}\n')
  // Local-only content beside the library that must never be packed.
  writeFileSync(join(root, 'tsconfig.json'), '{}\n')
  const appDir = join(root, 'app')
  mkdirSync(appDir)
  writeFileSync(join(appDir, 'package.json'), JSON.stringify(APP_MANIFEST, null, 2))
  writeFileSync(join(dirname(appDir), 'package-lock.json'), JSON.stringify({packages: {'node_modules/@reactivapp/mobile': {version: '2608.13.1'}}}))
  writeFileSync(join(appDir, 'index.js'), "import '@reactivapp/mobile/src/index';\n")
  writeInstalled(root, '@reactivapp/mobile', {version: '2608.13.1', dependencies: {}})
  writeInstalled(root, 'react', {version: '19.2.3'})
  writeInstalled(root, 'react-native', {version: '0.86.0'})
  writeInstalled(root, 'date-fns', {version: '4.1.0'})
}

describe('app submit against a mock vending API and a fixture registry', () => {
  let workDir: string
  let projectDir: string
  let shim: NpmShim
  let mock: Awaited<ReturnType<typeof startMockVending>>
  let tokenReplies: MockReply[]
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'submit-dry-run-')))
    projectDir = join(workDir, 'project')
    mkdirSync(projectDir)
    writeFixtureProject(projectDir)
    shim = installNpmShim(workDir)
    tokenReplies = []
    mock = await startMockVending({
      'GET /v1/me': () => ({status: 200, body: meResponse()}),
      'POST /v1/tokens': () => tokenReplies.shift() ?? {status: 200, body: tokenResponse()},
    })
    env = isolatedEnv(join(workDir, 'home'), {
      ...shim.env,
      REACTIV_VENDING_API_URL: mock.url,
      REACTIV_API_KEY: API_KEY,
      FAKE_NPM_PUBLISH_COPY: join(workDir, 'published.tgz'),
    })
  })

  afterEach(async () => {
    await mock.close()
    rmSync(workDir, {recursive: true, force: true})
  })

  const submit = async (
    registryVersions: string[],
    {viewFailure, dryRun = true}: {viewFailure?: {status: number; stderr: string}; dryRun?: boolean} = {},
  ) => {
    writeFileSync(shim.env.FAKE_NPM_VIEW_STDOUT, viewFailure ? '' : JSON.stringify(registryVersions))
    writeFileSync(shim.env.FAKE_NPM_VIEW_STDERR, viewFailure?.stderr ?? '')
    const result = await runCli(['app', 'submit', ...(dryRun ? ['--dry-run'] : [])], {
      cwd: projectDir,
      env: {...env, FAKE_NPM_VIEW_STATUS: String(viewFailure?.status ?? 0)},
    })
    assertNoSecrets(result.stdout, result.stderr, readFileSync(shim.log, 'utf8'))
    return result
  }

  const npmCalls = (verb: string): string[] =>
    readFileSync(shim.log, 'utf8').split('\n').filter(line => line.startsWith(`${verb} `))

  // oclif wraps long error lines behind a ' ›' gutter; join them back up.
  const flat = (text: string): string => text.replace(/\s*›\s*/g, ' ').replace(/\s+/g, ' ')

  const publishedTarball = (): string => {
    if (npmCalls('publish').length === 0) throw new Error('nothing was published')
    return join(workDir, 'published.tgz')
  }

  it('prints the allocated prerelease version, its review cycle and the vended registry', async () => {
    const result = await submit(['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8-draft.1'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Dry run complete (publish skipped)')
    expect(result.stdout).toContain('@reactiv-submissions/acme@0.1.8-draft.2')
    expect(result.stdout).toContain('review cycle 0.1.8 (approval will publish 0.1.8)')
    expect(result.stdout).toContain('dist-tag draft')
    // The receipt banner wraps long lines; compare with its borders and whitespace removed.
    expect(result.stdout.replace(/[│\s]/g, '')).toContain(`registry${REGISTRY_URL}`)
    expect(npmCalls('view')[0]).toBe(
      `view @reactiv-submissions/acme@draft versions --json --@reactiv-submissions:registry=${REGISTRY_URL} --loglevel notice`,
    )
  }, 30_000)

  it('moves to the next base after approval published the draft base', async () => {
    const result = await submit(['0.1.7', '0.1.8-draft.1', '0.1.8-draft.2', '0.1.8'])
    expect(result.stdout).toContain('@reactiv-submissions/acme@0.1.9-draft.1')
  }, 30_000)

  it('allocates 0.1.0-draft.1 when the package was never published', async () => {
    const result = await submit([], {viewFailure: {status: 1, stderr: 'npm error code E404\nnpm error 404 Not Found'}})
    expect(result.stdout).toContain('@reactiv-submissions/acme@0.1.0-draft.1')
    expect(result.stdout).toContain('review cycle 0.1.0')
  }, 30_000)

  it('heals a registry E401 with one silent re-mint and one retry', async () => {
    tokenReplies.push({status: 200, body: tokenResponse()}, {status: 200, body: tokenResponse({token: OTHER_TOKEN})})
    const result = await runCli(['app', 'submit', '--dry-run'], {cwd: projectDir, env: {...env, FAKE_NPM_E401_ONCE: join(workDir, 'e401-done')}})
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Dry run complete')
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toHaveLength(2)
    expect(readFileSync(join(projectDir, '.npmrc'), 'utf8')).toContain(OTHER_TOKEN)
    expect(npmCalls('view')).toHaveLength(2)
    assertNoSecrets(result.stdout, result.stderr)
  }, 30_000)

  it('retries the version query against the refreshed registry URL', async () => {
    const moved = REGISTRY_URL.replace('submissions-acme/', 'submissions-acme-moved/')
    tokenReplies.push({status: 200, body: tokenResponse()}, {status: 200, body: tokenResponse({registryUrl: moved})})
    const result = await runCli(['app', 'submit', '--dry-run'], {cwd: projectDir, env: {...env, FAKE_NPM_E401_ONCE: join(workDir, 'e401-done')}})
    expect(result.code).toBe(0)
    const views = npmCalls('view')
    expect(views[0]).toContain(`--@reactiv-submissions:registry=${REGISTRY_URL} `)
    expect(views[1]).toContain(`--@reactiv-submissions:registry=${moved} `)
    expect(result.stdout.replace(/[│\s]/g, '')).toContain(`registry${moved}`)
  }, 30_000)

  it('refuses to publish an allocated version to a registry that changed during the publish retry', async () => {
    const moved = REGISTRY_URL.replace('submissions-acme/', 'submissions-acme-moved/')
    tokenReplies.push({status: 200, body: tokenResponse()}, {status: 200, body: tokenResponse({registryUrl: moved})})
    writeFileSync(shim.env.FAKE_NPM_VIEW_STDOUT, '["0.1.7"]')
    const result = await runCli(['app', 'submit'], {
      cwd: projectDir,
      env: {...env, FAKE_NPM_E401_ONCE: join(workDir, 'e401-done'), FAKE_NPM_E401_ONCE_VERB: 'publish'},
    })
    expect(result.code).not.toBe(0)
    expect(result.errorText).toContain('The submissions registry changed while publishing; nothing was published. Run `reactiv app submit` again.')
    expect(npmCalls('publish')).toHaveLength(1)
  }, 30_000)

  it('spends at most one re-mint per command across the version query and the publish', async () => {
    writeFileSync(shim.env.FAKE_NPM_VIEW_STDOUT, '["0.1.7"]')
    const result = await runCli(['app', 'submit'], {
      cwd: projectDir,
      env: {...env, FAKE_NPM_E401_ONCE: join(workDir, 'e401-done'), FAKE_NPM_E401_ONCE_VERB: 'view', FAKE_NPM_E401_ALWAYS_VERB: 'publish'},
    })
    expect(result.code).not.toBe(0)
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toHaveLength(2)
    expect(npmCalls('publish')).toHaveLength(1)
  }, 30_000)

  it('stops with a login hint when the registry keeps refusing the version query', async () => {
    const result = await submit([], {viewFailure: {status: 1, stderr: 'npm error code E401'}})
    expect(result.code).not.toBe(0)
    expect(result.errorText).toContain('check your Reactiv login (`reactiv whoami`)')
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toHaveLength(2)
  }, 30_000)

  it('publishes with the draft dist-tag and the scope-specific registry flag', async () => {
    const result = await submit(['0.1.7', '0.1.8-draft.1'], {dryRun: false})
    expect(result.stdout).toContain('Submission published')
    expect(result.stdout).toContain('@reactiv-submissions/acme@0.1.8-draft.2')
    const publish = npmCalls('publish')
    expect(publish).toHaveLength(1)
    expect(publish[0]).toMatch(
      /^publish \S+reactiv-submissions-acme-0\.1\.8-draft\.2\.tgz --tag draft --@reactiv-submissions:registry=\S+ --loglevel notice$/,
    )
    expect(publish[0]).toContain(`--@reactiv-submissions:registry=${REGISTRY_URL}`)
  }, 30_000)

  it('a stale npmjs scope line in .npmrc loses to the vended registry', async () => {
    writeFileSync(join(projectDir, '.npmrc'), '@reactiv-submissions:registry=https://registry.npmjs.org/\n')
    await submit(['0.1.7'], {dryRun: false})
    for (const call of [...npmCalls('view'), ...npmCalls('publish')]) {
      expect(call).toContain(`--@reactiv-submissions:registry=${REGISTRY_URL}`)
      expect(call).not.toContain('registry.npmjs.org')
    }
    const npmrc = readFileSync(join(projectDir, '.npmrc'), 'utf8')
    expect(npmrc).not.toContain('registry.npmjs.org')
    expect(npmrc).toContain(`@reactiv-submissions:registry=${REGISTRY_URL}`)
  }, 30_000)

  it('refuses a project that belongs to another merchant before minting', async () => {
    writeFileSync(join(projectDir, 'reactiv.conf.js'), "module.exports = {appUuid: '11111111-1111-1111-1111-111111111111', appName: 'Globex'}\n")
    const result = await submit(['0.1.7'])
    expect(result.code).not.toBe(0)
    expect(result.errorText).toContain('but this project belongs to acme (11111111-1111-1111-1111-111111111111)')
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toEqual([])
    expect(npmCalls('view')).toEqual([])
  }, 30_000)

  it('needs a login and queries nothing without one', async () => {
    const result = await runCli(['app', 'submit', '--dry-run'], {cwd: projectDir, env: {...env, REACTIV_API_KEY: ''}})
    expect(result.code).not.toBe(0)
    expect(result.errorText).toContain('Not logged in. Run `reactiv login` with the API key Reactiv issued to your team.')
    expect(npmCalls('view')).toEqual([])
  }, 30_000)

  it('never publishes on a dry run', async () => {
    await submit(['0.1.7'])
    expect(npmCalls('publish')).toEqual([])
  }, 30_000)

  // Assembled at runtime so no credential-shaped literal sits in this file.
  const underscore = '_'
  const fakeCredentials: Array<{file: string; label: string; value: string}> = [
    {file: 'aws-id.ts', label: 'AWS access key ID', value: `${'AKIA'}${'Q'.repeat(16)}`},
    {file: 'aws-secret.ts', label: 'AWS secret access key', value: `${['aws', 'secret', 'access', 'key'].join(underscore)} = ${'Q7'.repeat(20)}`},
    {file: 'github.ts', label: 'GitHub token', value: `${'gh'}p_${'a'.repeat(36)}`},
    {file: 'github-fine.ts', label: 'GitHub fine-grained token', value: `${['github', 'pat'].join(underscore)}_${'b'.repeat(30)}`},
    {file: 'shopify.ts', label: 'Shopify access token', value: `${'shp'}at_${'f'.repeat(32)}`},
    {file: 'npm.ts', label: 'npm token', value: `${'npm'}_${'c'.repeat(36)}`},
    {file: 'deploy.pem', label: 'PEM private key', value: `${'-'.repeat(5)}BEGIN OPENSSH PRIVATE KEY${'-'.repeat(5)}`},
    {file: 'reactiv.ts', label: 'Reactiv API key', value: `${'rpk'}_${'0'.repeat(26)}_${'x'.repeat(8)}`},
  ]

  it('stages one fake credential per pattern class', () => {
    expect(fakeCredentials.map(c => c.label).sort()).toEqual(SECRET_PATTERNS.map(p => p.label).sort())
  })

  for (const dryRun of [true, false]) {
    it(`rejects staged credentials of every class with file, line and pattern class${dryRun ? ' on a dry run' : ''}, and publishes nothing`, async () => {
      mkdirSync(join(projectDir, 'src', 'config'), {recursive: true})
      for (const {file, value} of fakeCredentials) {
        writeFileSync(join(projectDir, 'src', 'config', file), `export const region = 'us-east-1'\nexport const value = '${value}'\n`)
      }
      const failure = await submit(['0.1.7'], {dryRun})
      expect(failure.code).not.toBe(0)
      expect(failure.stderr).toContain('possible credentials found in the submission')
      for (const {file, label} of fakeCredentials) expect(failure.stderr).toContain(`src/config/${file}:2  ${label}`)
      expect(failure.stderr).toContain('rotate')
      expect(failure.stdout).not.toContain('Dry run complete')
      const output = `${failure.stdout}${failure.stderr}`
      for (const {label, value} of fakeCredentials) {
        expect(output.includes(value), `the ${label} value leaked into the CLI output`).toBe(false)
      }
      expect(npmCalls('publish')).toEqual([])
    }, 30_000)
  }

  it('accepts credential look-alikes on a dry run', async () => {
    writeFileSync(join(projectDir, 'src', 'notes.ts'), `export const npmDir = '${'npm'}_modules'\nexport const cert = '${'-'.repeat(5)}BEGIN CERTIFICATE${'-'.repeat(5)}'\n`)
    expect((await submit(['0.1.7'])).stdout).toContain('Dry run complete (publish skipped)')
  }, 30_000)

  it('stops before any login or registry work when app/ declares a library dependency', async () => {
    writeFileSync(join(projectDir, 'app', 'package.json'), JSON.stringify({...APP_MANIFEST, dependencies: {...PLATFORM_PEERS, 'date-fns': '4.1.0'}}))
    const failure = await submit(['0.1.7'])
    expect(failure.code).not.toBe(0)
    expect(flat(failure.stderr)).toContain('date-fns: already declared in package.json ("4.1.0") — remove it from app/package.json')
    expect(flat(failure.stderr)).toContain('run `npm install` at the project root')
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toEqual([])
    expect(npmCalls('view')).toEqual([])
  }, 30_000)

  it('stops before any login on a dependency range that review could not pin', async () => {
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({...LIBRARY_MANIFEST, dependencies: {'date-fns': '^4.1.0'}}))
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('must be exact versions')
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toEqual([])
  }, 30_000)

  it('stops before any login when the library files field would pack more than src/', async () => {
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({...LIBRARY_MANIFEST, files: ['src', 'tsconfig.json']}))
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('"files" must be exactly ["src"]')
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toEqual([])
  }, 30_000)

  const noTokenNoRegistry = (): void => {
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toEqual([])
    expect(npmCalls('view')).toEqual([])
  }

  it('stops on the old layout with a migration hint, before any login', async () => {
    rmSync(join(projectDir, 'app'), {recursive: true})
    mkdirSync(join(projectDir, 'custom'))
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('old layout')
    noTokenNoRegistry()
  }, 30_000)

  it('stops before any login when the entry file is missing', async () => {
    rmSync(join(projectDir, 'src', 'index.ts'))
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('entry point src/index.ts')
    noTokenNoRegistry()
  }, 30_000)

  it('stops before any login when the entry does not export the contract', async () => {
    writeFileSync(join(projectDir, 'src', 'index.ts'), 'export const nothing = 1;\n')
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('must export CustomCompositions and registerCustomComponents')
    noTokenNoRegistry()
  }, 30_000)

  it('stops before any login when src/ is a file', async () => {
    rmSync(join(projectDir, 'src'), {recursive: true})
    writeFileSync(join(projectDir, 'src'), 'not a directory')
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('src/ not found')
    noTokenNoRegistry()
  }, 30_000)

  it('stops before any login when src/ imports a package package.json does not declare', async () => {
    writeFileSync(join(projectDir, 'src', 'customizations', 'extra.ts'), "import {chunk} from 'lodash/chunk';\nexport const extra = chunk;\n")
    const failure = await submit(['0.1.7'])
    expect(failure.code).not.toBe(0)
    expect(flat(failure.stderr)).toContain('lodash: "lodash/chunk" in src/customizations/extra.ts:1 — run `npm install --save-exact lodash@<version>` at the project root')
    noTokenNoRegistry()
  }, 30_000)

  it('stops before any login on a Node built-in or a computed import in src/', async () => {
    writeFileSync(join(projectDir, 'src', 'customizations', 'extra.ts'), "import {readFile} from 'node:fs';\nconst name = 'x';\nexport const load = () => import(name);\nexport {readFile};\n")
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('"node:fs" in src/customizations/extra.ts:1 — remove the import')
    expect(flat(failure.stderr)).toContain('imports must be string literals')
    expect(flat(failure.stderr)).toContain('src/customizations/extra.ts:3 — import()')
    noTokenNoRegistry()
  }, 30_000)

  it('re-checks the staged src/ so an import added during login never reaches the pack', async () => {
    await plantDuringLogin(() => writeFileSync(join(projectDir, 'src', 'customizations', 'late.ts'), "import chunk from 'lodash/chunk';\nexport const late = chunk;\n"))
    const failure = await submit(['0.1.7'], {dryRun: false})
    expect(failure.code).not.toBe(0)
    expect(flat(failure.stderr)).toContain('lodash: "lodash/chunk" in src/customizations/late.ts:1')
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).not.toEqual([])
    expect(npmCalls('view')).not.toEqual([])
    expect(npmCalls('pack')).toEqual([])
    expect(npmCalls('publish')).toEqual([])
  }, 30_000)

  it('warns about a declared dependency nothing imports and still completes', async () => {
    writeFileSync(join(projectDir, 'src', 'customizations', 'CustomCompositions.tsx'), 'export const CustomCompositions = {};\n')
    const result = await submit(['0.1.7'])
    expect(result.code).toBe(0)
    expect(flat(result.stderr)).toContain('package.json declares date-fns but nothing in src/ imports it')
    expect(result.stdout).toContain('Dry run complete')
  }, 30_000)

  it('stops before any login on a dependency whose podspec runs build scripts', async () => {
    const dependencies = {'date-fns': '4.1.0', 'scripted-native': '1.0.0'}
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({...LIBRARY_MANIFEST, dependencies}))
    writeInstalled(projectDir, 'scripted-native', {version: '1.0.0'})
    writeFileSync(join(projectDir, 'node_modules', 'scripted-native', 'scripted-native.podspec'), "Pod::Spec.new do |s|\n  s.script_phases = [{:name => 'gen'}]\nend\n")
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('require native project changes a customization cannot ship — contact Reactiv')
    expect(flat(failure.stderr)).toContain('scripted-native: node_modules/scripted-native/scripted-native.podspec sets script_phases')
    noTokenNoRegistry()
  }, 30_000)

  it('refuses to write a token into an app/.npmrc that git would not ignore', async () => {
    writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n/.npmrc\n')
    execFileSync('git', ['init', '--quiet'], {cwd: projectDir})
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('.gitignore does not ignore app/.npmrc')
    noTokenNoRegistry()
  }, 30_000)

  it('refuses a symlink that appears in src/ during login instead of packing its target', async () => {
    await mock.close()
    mock = await startMockVending({
      'GET /v1/me': () => ({status: 200, body: meResponse()}),
      'POST /v1/tokens': () => {
        symlinkSync(join(projectDir, 'tsconfig.json'), join(projectDir, 'src', 'late-link.ts'))
        return {status: 200, body: tokenResponse()}
      },
    })
    env = {...env, REACTIV_VENDING_API_URL: mock.url}
    const failure = await submit(['0.1.7'], {dryRun: false})
    expect(failure.code).not.toBe(0)
    expect(flat(failure.stderr)).toContain('late-link.ts (symlink)')
    expect(npmCalls('publish')).toEqual([])
  }, 30_000)

  const plantDuringLogin = async (plant: () => void): Promise<void> => {
    await mock.close()
    mock = await startMockVending({
      'GET /v1/me': () => ({status: 200, body: meResponse()}),
      'POST /v1/tokens': () => {
        plant()
        return {status: 200, body: tokenResponse()}
      },
    })
    env = {...env, REACTIV_VENDING_API_URL: mock.url}
  }

  it('refuses a directory symlink that appears in src/ during login', async () => {
    mkdirSync(join(projectDir, 'outside'))
    writeFileSync(join(projectDir, 'outside', 'leak.ts'), 'export const leak = 1;\n')
    await plantDuringLogin(() => symlinkSync('../outside', join(projectDir, 'src', 'linked-dir')))
    const failure = await submit(['0.1.7'], {dryRun: false})
    expect(flat(failure.stderr)).toContain('linked-dir (symlink)')
    expect(npmCalls('publish')).toEqual([])
  }, 30_000)

  it('refuses src/ swapped for a symlink during login', async () => {
    await plantDuringLogin(() => {
      renameSync(join(projectDir, 'src'), join(projectDir, 'real-src'))
      symlinkSync(join(projectDir, 'real-src'), join(projectDir, 'src'))
    })
    const failure = await submit(['0.1.7'], {dryRun: false})
    expect(flat(failure.stderr)).toMatch(/symlink — src\/ must be a real directory|could not stage src\//)
    expect(npmCalls('publish')).toEqual([])
  }, 30_000)

  it('refuses a hard link in src/ before any login', async () => {
    writeFileSync(join(projectDir, 'outside.txt'), 'outside content\n')
    linkSync(join(projectDir, 'outside.txt'), join(projectDir, 'src', 'hard.ts'))
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('hard.ts (hard link')
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toEqual([])
  }, 30_000)

  it('refuses a special file in src/ before any login', async () => {
    execFileSync('mkfifo', [join(projectDir, 'src', 'pipe')])
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('pipe (special file)')
    expect(mock.requests.filter(request => request.path === '/v1/tokens')).toEqual([])
  }, 30_000)

  it('refuses a dotfile under src/ before packing', async () => {
    writeFileSync(join(projectDir, 'src', '.env'), 'SETTING=1\n')
    const failure = await submit(['0.1.7'])
    expect(flat(failure.stderr)).toContain('.env (hidden')
  }, 30_000)

  it('packs exactly the root library: package.json plus src/**', async () => {
    writeFileSync(join(projectDir, 'src', '.DS_Store'), 'finder')
    await submit(['0.1.7'], {dryRun: false})
    const listing = execFileSync('tar', ['-tzf', publishedTarball()], {encoding: 'utf8'}).trim().split('\n').sort()
    expect(listing).toEqual([
      'package/package.json',
      'package/src/customizations/CustomCompositions.tsx',
      'package/src/customizations/registerCustomComponents.tsx',
      'package/src/index.ts',
    ])
  }, 30_000)

  it('stamps the submission identity onto the library manifest, keeping dependencies and dropping local-only fields', async () => {
    const result = await submit(['0.1.7'], {dryRun: false})
    expect(result.stdout).toContain('dependencies date-fns')
    const manifest = JSON.parse(execFileSync('tar', ['-xzf', publishedTarball(), '-O', 'package/package.json'], {encoding: 'utf8'}))
    expect(manifest).toEqual({
      name: '@reactiv-submissions/acme',
      version: '0.1.8-draft.1',
      description: 'Reactiv Plus customization submission for Acme',
      main: 'src/index.ts',
      'react-native': 'src/index.ts',
      files: ['src'],
      dependencies: {'date-fns': '4.1.0'},
      license: 'UNLICENSED',
      reactivPlus: {appUuid: MERCHANT.appUuid, merchantSlug: 'acme', platformVersion: '2608.13.1'},
    })
  }, 30_000)
})
