import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {AuthError} from './auth/errors'
import {writeFileAtomic} from './auth/files'
import {renderBlock, TOOLS_SCOPE} from './auth/npmrc'
import {type AuthContext, refreshAfterRegistryAuthError, takeRegistryRetry, type RegistryAuth} from './auth/token'
import {APP_DIR, readManifest} from './layout'
import {captureAll, isRegistryAuthError, NPM_LOGLEVEL, npmEnv, runTee} from './npm'

export interface RegistryUrls {
  registryUrl: string
  toolsRegistryUrl: string
}

export interface RegistryOperation {
  command: string
  activity: string
  outcome: string
}

export const INIT_OPERATION: RegistryOperation = {
  command: 'reactiv app init',
  activity: 'setting up the project',
  outcome: 'nothing was scaffolded from mixed sources',
}

export const assertSameRegistries = (expected: RegistryUrls, actual: RegistryUrls, operation: RegistryOperation = INIT_OPERATION): void => {
  const tools = actual.toolsRegistryUrl !== expected.toolsRegistryUrl
  const submissions = actual.registryUrl !== expected.registryUrl
  if (!tools && !submissions) return
  const moved = tools && submissions ? 'tools and submissions registries' : tools ? 'tools registry' : 'submissions registry'
  throw new AuthError(`The Reactiv ${moved} changed while ${operation.activity}; ${operation.outcome}. Run \`${operation.command}\` again.`)
}

export class BootstrapRegistry {
  private readonly userconfig: string
  private succeeded = 0

  constructor(
    private readonly ctx: AuthContext,
    private readonly workDir: string,
    private auth: RegistryAuth,
    private readonly operation: RegistryOperation = INIT_OPERATION,
  ) {
    this.userconfig = path.join(workDir, 'npmrc')
    this.writeUserconfig()
  }

  private writeUserconfig(): void {
    writeFileAtomic(this.userconfig, renderBlock(this.auth) + '\n')
  }

  private exec(args: string[], loglevel: string): ReturnType<typeof captureAll> {
    return captureAll('npm', [...args, `--${TOOLS_SCOPE}:registry=${this.auth.toolsRegistryUrl}`, '--loglevel', loglevel], {
      cwd: this.workDir,
      env: npmEnv({NPM_CONFIG_USERCONFIG: this.userconfig}),
    })
  }

  get registryUrl(): string {
    return this.auth.registryUrl
  }

  get toolsRegistryUrl(): string {
    return this.auth.toolsRegistryUrl
  }

  async npm(args: string[], loglevel = NPM_LOGLEVEL): Promise<string> {
    let result = this.exec(args, loglevel)
    if (result.status !== 0 && isRegistryAuthError(result.stderr) && takeRegistryRetry(this.ctx)) {
      const previous = {toolsRegistryUrl: this.auth.toolsRegistryUrl, registryUrl: this.auth.registryUrl}
      this.auth = await refreshAfterRegistryAuthError(this.ctx)
      // Earlier lookups came from the old registry; mixing their results with this one is not safe.
      if (this.succeeded > 0) assertSameRegistries(previous, this.auth, this.operation)
      this.writeUserconfig()
      result = this.exec(args, loglevel)
    }
    if (result.status !== 0) {
      throw new Error(`npm ${args[0]} ${args[1] ?? ''} failed — check your Reactiv login (\`reactiv whoami\`):\n${result.stderr}`)
    }
    if (loglevel === 'http' && result.stderr) process.stderr.write(result.stderr + '\n')
    this.succeeded += 1
    return result.stdout
  }

  private unreadable(args: string[]): Error {
    return new Error(`npm ${args.join(' ')} returned unreadable output — run \`reactiv whoami\` to check your login`)
  }

  private async viewJson(args: string[], empty?: string): Promise<unknown> {
    const output = (await this.npm(args)).trim() || empty
    if (output === undefined) throw this.unreadable(args)
    try {
      return JSON.parse(output) as unknown
    } catch {
      throw this.unreadable(args)
    }
  }

  async latestPlatformVersion(): Promise<string> {
    const args = ['view', '@reactivapp/mobile', 'version']
    const version = (await this.npm(args)).trim()
    if (version !== '' && !/^\d+\.\d+\.\d+\S*$/.test(version)) throw this.unreadable(args)
    return version
  }

  async platformVersions(): Promise<string[]> {
    const parsed = await this.viewJson(['view', '@reactivapp/mobile', 'versions', '--json'])
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.filter((version): version is string => typeof version === 'string')
  }

  async platformManifestField(version: string, field: 'dependencies' | 'peerDependencies'): Promise<Record<string, string>> {
    const parsed = await this.viewJson(['view', `@reactivapp/mobile@${version}`, field, '--json'], '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  }

  async fetchTemplate(): Promise<string> {
    const packOutput = await this.npm(['pack', '@reactivapp/app-template', '--pack-destination', this.workDir, '--ignore-scripts'], 'http')
    const tarball = packOutput.trim().split('\n').pop() ?? ''
    if (!tarball.endsWith('.tgz')) throw new Error('npm pack @reactivapp/app-template printed no tarball name — check your Reactiv login (`reactiv whoami`)')
    execFileSync('tar', ['-xzf', path.join(this.workDir, tarball), '-C', this.workDir])
    const templateDir = path.join(this.workDir, 'package', 'template')
    if (!fs.existsSync(templateDir)) throw new Error('the downloaded @reactivapp/app-template has no template/ directory — ask Reactiv to publish the current template')
    return templateDir
  }
}

export const installWithRegistryAuth = async (
  ctx: AuthContext,
  registry: RegistryUrls,
  projectRoot: string,
  cwd: string,
  operation: RegistryOperation = INIT_OPERATION,
): Promise<void> => {
  const installArgs = ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--legacy-peer-deps', '--loglevel', NPM_LOGLEVEL]
  let result = await runTee('npm', installArgs, {cwd, env: npmEnv()})
  if (result.status !== 0 && isRegistryAuthError(result.stderr) && takeRegistryRetry(ctx)) {
    assertSameRegistries(registry, await refreshAfterRegistryAuthError(ctx, projectRoot), operation)
    result = await runTee('npm', installArgs, {cwd, env: npmEnv()})
  }
  if (result.status !== 0 && isRegistryAuthError(result.stderr)) {
    throw new AuthError(`the registry rejected the token during npm install — run \`reactiv whoami\` (or \`reactiv login\`) and re-run \`${operation.command}\``)
  }
  if (result.status !== 0) throw new Error(`npm install in ${path.relative(projectRoot, cwd) || '.'} exited with ${result.status}`)
}

export const skippedInstallScripts = (appDir: string): string[] => {
  const appScripts = (readManifest(path.join(appDir, 'package.json')).scripts ?? {}) as Record<string, unknown>
  const lockPath = path.join(appDir, 'package-lock.json')
  let lockPackages: Record<string, {hasInstallScript?: boolean}> = {}
  try {
    if (fs.existsSync(lockPath)) lockPackages = (readManifest(lockPath).packages ?? {}) as Record<string, {hasInstallScript?: boolean}>
  } catch {
    lockPackages = {}
  }
  return [
    ...['preinstall', 'install', 'postinstall', 'prepare'].filter(name => Object.hasOwn(appScripts, name)).map(name => `${APP_DIR}/package.json ${name}`),
    ...Object.entries(lockPackages).filter(([, entry]) => entry.hasInstallScript).map(([key]) => key.replace(/^.*node_modules\//, '')),
  ]
}
