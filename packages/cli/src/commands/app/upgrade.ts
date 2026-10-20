import {Command, Flags} from '@oclif/core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {createAuthContext, reportAuthError} from '../../lib/auth/context'
import {writeFileAtomic} from '../../lib/auth/files'
import {ensureRegistryAuth, type RegistryAuth} from '../../lib/auth/token'
import {BootstrapRegistry, installWithRegistryAuth, type RegistryOperation, skippedInstallScripts} from '../../lib/bootstrap-registry'
import {APP_DIR, assertDependenciesInSync, assertNpmrcFilesIgnored, assertWorkspaceLayout, readManifest, resolveLayout, type ProjectLayout} from '../../lib/layout'
import {npmEnv, runTee} from '../../lib/npm'
import {loadProjectIdentity, PROJECT_CONFIG, type ProjectIdentity} from '../../lib/project'
import {defaultBundleIdentifier} from '../../lib/scaffold'
import {
  compareVersions,
  findDelegationSteps,
  formatDelegationSteps,
  isExactVersion,
  type ManifestSection,
  type PlatformTrio,
  setPlatformVersions,
} from '../../lib/upgrade'

const UPGRADE_OPERATION: RegistryOperation = {
  command: 'reactiv app upgrade',
  activity: 'upgrading the project',
  outcome: 'nothing was installed from mixed sources',
}

const POD_STEP = `cd ${APP_DIR}/ios && pod install`

export class AppUpgrade extends Command {
  static override description =
    'Move the project to another @reactivapp/mobile platform version (default: the version `reactiv app init` installs today), reinstall, and typecheck'

  static override flags = {
    to: Flags.string({description: 'exact @reactivapp/mobile version to move to (required to move to an older version)'}),
  }

  async run(): Promise<void> {
    const {renderInfo, renderSuccess, renderWarning} = await import('@reactivapp/cli-ui')
    const {flags} = await this.parse(AppUpgrade)
    const projectRoot = process.cwd()

    if (!fs.existsSync(path.join(projectRoot, PROJECT_CONFIG))) {
      this.error(`not a Reactiv Plus project (${PROJECT_CONFIG} not found) — run this from the project root`)
    }

    let project: ProjectIdentity
    let layout: ProjectLayout
    let previous: string
    let libraryPlatform: unknown
    const libraryPath = path.join(projectRoot, 'package.json')
    const appPath = path.join(projectRoot, APP_DIR, 'package.json')
    try {
      project = loadProjectIdentity(projectRoot)
      layout = resolveLayout(projectRoot)
      libraryPlatform = (readManifest(libraryPath).peerDependencies as Record<string, unknown> | undefined)?.['@reactivapp/mobile']
      const installed = readManifest(appPath).dependencies?.['@reactivapp/mobile']
      if (typeof installed !== 'string' || installed.trim() === '') {
        throw new Error(`${APP_DIR}/package.json does not depend on @reactivapp/mobile — this is not a scaffolded Reactiv Plus project`)
      }
      previous = installed
      assertWorkspaceLayout(readManifest(libraryPath))
      assertNpmrcFilesIgnored(projectRoot)
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error))
    }
    if (flags.to !== undefined && !isExactVersion(flags.to)) {
      this.error(`--to takes an exact version such as 2610.9.3 (got "${flags.to}")`)
    }
    if (flags.to === undefined && !isExactVersion(previous)) {
      this.error(`${APP_DIR}/package.json declares @reactivapp/mobile "${previous}", not an exact version, so the CLI cannot tell whether the newest release is an upgrade — name the version with --to`)
    }
    const rollback = isExactVersion(previous)
      ? `reactiv app upgrade --to ${previous}`
      : `restore package.json, ${APP_DIR}/package.json and package-lock.json from git (the previous @reactivapp/mobile "${previous}" was not an exact version), then run npm install at the project root`

    const ctx = createAuthContext(this)
    let auth: RegistryAuth
    try {
      auth = await ensureRegistryAuth(ctx, projectRoot)
    } catch (error) {
      return reportAuthError(this, error)
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reactiv-upgrade-'))
    let trio: PlatformTrio
    const failures: string[] = []
    let started = false
    try {
      const registry = new BootstrapRegistry(ctx, workDir, auth, UPGRADE_OPERATION)
      const onLine =
        libraryPlatform === previous
          ? `this project is on @reactivapp/mobile@${previous}`
          : `this project is on @reactivapp/mobile@${previous} in ${APP_DIR}/package.json, but package.json peerDependencies declare ${typeof libraryPlatform === 'string' ? libraryPlatform : 'none'} — the rollback restores ${previous} into both`
      renderInfo({headline: 'Resolving Reactiv platform', body: [onLine]})

      let target: string
      if (flags.to === undefined) {
        target = await registry.latestPlatformVersion()
        if (!target) throw new Error('could not resolve the @reactivapp/mobile version from the registry — run `reactiv whoami` to check your login')
        if (!isExactVersion(target)) throw new Error(`the registry's current @reactivapp/mobile is "${target}", not an exact version; nothing changed — name a version with --to`)
      } else {
        const published = await registry.platformVersions()
        if (!published.includes(flags.to)) {
          const recent = published.slice(-5).join(', ') || 'none'
          throw new Error(`@reactivapp/mobile@${flags.to} is not available to you — recent versions: ${recent}`)
        }
        target = flags.to
      }
      if (isExactVersion(previous) && compareVersions(target, previous) < 0) {
        if (flags.to === undefined) {
          throw new Error(`the newest @reactivapp/mobile available to you (${target}) is older than this project's ${previous}; nothing changed — pass --to ${target} to move back to it`)
        }
        this.warn(`moving back from ${previous} to the older ${target}, as --to asked — toolchain differences below are against the current app template, so keep your own files where they already worked on ${target}`)
      }

      const peers = await registry.platformManifestField(target, 'peerDependencies')
      if (!peers.react || !peers['react-native']) {
        throw new Error(`@reactivapp/mobile@${target} declares no react/react-native peers — run \`reactiv whoami\` to check your login, or pick another version with --to`)
      }
      if (!isExactVersion(peers.react) || !isExactVersion(peers['react-native'])) {
        throw new Error(`@reactivapp/mobile@${target} pins react "${peers.react}" and react-native "${peers['react-native']}", which are not exact versions; nothing changed — pick another version with --to`)
      }
      trio = {'@reactivapp/mobile': target, react: peers.react, 'react-native': peers['react-native']}

      this.log('Downloading @reactivapp/app-template…')
      const templateDir = await registry.fetchTemplate()

      const edits: Array<[string, ManifestSection]> = [
        [libraryPath, 'peerDependencies'],
        [appPath, 'dependencies'],
      ]
      let changed = false
      for (const [manifestPath, section] of edits) {
        const before = fs.readFileSync(manifestPath, 'utf8')
        const after = setPlatformVersions(before, section, trio)
        if (after === before) continue
        const mode = fs.statSync(manifestPath).mode & 0o777
        started = true
        writeFileAtomic(manifestPath, after)
        try {
          fs.chmodSync(manifestPath, mode)
        } catch (error) {
          this.warn(`could not restore the file mode of ${path.relative(projectRoot, manifestPath)} (${error instanceof Error ? error.message : String(error)}) — it is now readable only by you`)
        }
        changed = true
        this.log(`Updated ${path.relative(projectRoot, manifestPath)} ${section}: ${Object.entries(trio).map(([name, version]) => `${name}@${version}`).join(', ')}`)
      }
      if (!changed) this.log(`package.json and ${APP_DIR}/package.json already declare @reactivapp/mobile@${target} and its peers — reinstalling to match`)

      this.log(`Installing dependencies (npm, one install for the library and ${APP_DIR}/)…`)
      started = true
      await installWithRegistryAuth(ctx, registry, projectRoot, projectRoot, UPGRADE_OPERATION)
      const skipped = skippedInstallScripts(projectRoot)
      if (skipped.length > 0) {
        this.warn(`install scripts were not run for: ${skipped.join(', ')} — run \`npm rebuild\` at the project root if the app fails to build`)
      }
      try {
        assertDependenciesInSync(layout)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }

      const steps = findDelegationSteps(
        templateDir,
        projectRoot,
        {
          appName: project.appName,
          appSlug: project.slug,
          appUuid: project.appUuid,
          bundleIdentifier: defaultBundleIdentifier(project.slug),
          platformVersion: trio['@reactivapp/mobile'],
          reactVersion: trio.react,
          reactNativeVersion: trio['react-native'],
        },
        readManifest(libraryPath),
      )
      if (steps.length > 0) {
        renderWarning({headline: 'Toolchain files to update by hand', body: [`${steps.length} change${steps.length === 1 ? '' : 's'} listed below`]})
        this.log(formatDelegationSteps(steps))
      }
    } catch (error) {
      if (started) this.warn(`the upgrade stopped after it began changing the project (manifests, lockfiles or node_modules) — to roll back: ${rollback}`)
      return reportAuthError(this, error)
    } finally {
      fs.rmSync(workDir, {recursive: true, force: true})
    }

    this.log(`Native step (the CLI does not run it): ${POD_STEP}`)

    try {
      const scripts = (readManifest(libraryPath).scripts ?? {}) as Record<string, unknown>
      if (typeof scripts.typecheck === 'string') {
        this.log('Running the project typecheck (npm run typecheck)…')
        const result = await runTee('npm', ['run', 'typecheck'], {cwd: projectRoot, env: npmEnv()})
        if (result.status !== 0) failures.push(`npm run typecheck exited with ${result.status} — the errors are printed above`)
      } else {
        failures.push('package.json has no "typecheck" script, so the upgrade could not be checked — add the script the template ships (listed above) and run `npm run typecheck`')
      }
    } catch (error) {
      failures.push(`the typecheck could not run: ${error instanceof Error ? error.message : String(error)}`)
    }

    const summary = [
      `@reactivapp/mobile ${previous} → ${trio['@reactivapp/mobile']} (react ${trio.react}, react-native ${trio['react-native']})`,
      `roll back with: ${rollback}`,
    ]
    if (failures.length > 0) {
      this.error(
        [
          `upgrade applied, but the project does not check clean on @reactivapp/mobile@${trio['@reactivapp/mobile']}; the change stays in place for you to fix or roll back:`,
          ...failures.map(failure => `  ${failure.split('\n').join('\n  ')}`),
          ...summary,
        ].join('\n'),
      )
    }
    renderSuccess({
      headline: `Upgraded to @reactivapp/mobile@${trio['@reactivapp/mobile']}`,
      body: summary,
      nextSteps: [POD_STEP, 'reactiv app run ios'],
    })
  }
}
