import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {createAuthContext, reportAuthError} from '../../lib/auth/context'
import {gitIgnoreState, gitProbeEnv, installRoots} from '../../lib/auth/npmrc'
import {ensureRegistryAuth, type Identity, type RegistryAuth, resolveIdentity} from '../../lib/auth/token'
import {assertSameRegistries, BootstrapRegistry, installWithRegistryAuth, skippedInstallScripts} from '../../lib/bootstrap-registry'
import {APP_DIR, PLATFORM_PACKAGES, readManifest} from '../../lib/layout'
import {run} from '../../lib/npm'
import {defaultBundleIdentifier, expandedName, expandTemplate, isSlug} from '../../lib/scaffold'

const assertNpmrcIgnored = (targetDir: string): void => {
  for (const root of installRoots(targetDir)) {
    const relative = path.relative(targetDir, path.join(root, '.npmrc'))
    if (gitIgnoreState(path.join(root, '.npmrc')) !== 'ignored') {
      throw new Error(`the scaffold's .gitignore does not ignore ${relative} — refusing to write a registry token into a file git would commit`)
    }
  }
}

const assertNoNpmrcStaged = (targetDir: string): void => {
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {cwd: targetDir, encoding: 'utf8', env: gitProbeEnv()})
  const leaked = staged.split('\n').filter(file => path.basename(file) === '.npmrc')
  if (leaked.length > 0) {
    throw new Error(`refusing to commit ${leaked.join(', ')}: it holds a registry token`)
  }
}

export class AppInit extends Command {
  static override description =
    'Scaffold a new Reactiv Plus app project from @reactivapp/app-template for the merchant you are logged in as (platform version stamped from the registry)'

  static override flags = {
    'app-uuid': Flags.string({description: 'Reactiv app UUID; defaults to the app your login is provisioned for and is refused when it differs'}),
    path: Flags.string({description: 'parent directory to scaffold into', default: '.'}),
    'package-manager': Flags.string({description: 'package manager for the project', options: ['npm'], default: 'npm'}),
    'bundle-id': Flags.string({description: 'iOS bundle identifier (default com.reactiv.<slug>)'}),
    'skip-install': Flags.boolean({description: 'skip dependency installation', default: false}),
  }

  async run(): Promise<void> {
    const {renderSuccess, renderInfo} = await import('@reactivapp/cli-ui')
    const {flags} = await this.parse(AppInit)

    const ctx = createAuthContext(this)
    let identity: Identity
    try {
      identity = await resolveIdentity(ctx)
    } catch (error) {
      return reportAuthError(this, error)
    }
    // The merchant the login is provisioned for decides the project identity:
    // its slug is the folder, package and app name, its UUID the app.
    const appSlug = identity.merchant.slug
    if (!isSlug(appSlug)) {
      this.error(`the merchant slug Reactiv provisioned for this key ("${appSlug}") is not a plain lowercase name, so it cannot name a folder or package — contact Reactiv`)
    }
    const appUuid = identity.merchant.appUuid
    if (flags['app-uuid'] !== undefined && flags['app-uuid'] !== appUuid) {
      this.error(`--app-uuid ${flags['app-uuid']} is not the app your login is provisioned for (${appUuid}) — drop the flag, or log in with that app's key`)
    }
    const targetDir = path.resolve(flags.path, appSlug)
    if (fs.existsSync(targetDir)) {
      if (!fs.statSync(targetDir).isDirectory()) {
        this.error(`target path ${targetDir} exists and is not a directory`)
      }
      if (fs.readdirSync(targetDir).length > 0) {
        this.error(`target directory ${targetDir} already exists and is not empty`)
      }
    }

    let auth: RegistryAuth
    try {
      auth = await ensureRegistryAuth(ctx)
    } catch (error) {
      return reportAuthError(this, error)
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reactiv-init-'))
    const targetExistedBefore = fs.existsSync(targetDir)
    if (targetExistedBefore && fs.readdirSync(targetDir).length > 0) this.error(`target directory ${targetDir} is no longer empty`)
    const createdEntries = new Set<string>(['.git', '.npmrc', 'node_modules', 'package-lock.json'])
    let fileCount = 0
    let platformVersion = ''
    let reactVersion: string | undefined
    let reactNativeVersion: string | undefined
    try {
      const registry = new BootstrapRegistry(ctx, workDir, auth)

      renderInfo({headline: 'Resolving Reactiv platform', body: [`registry lookup for @reactivapp/mobile + @reactivapp/app-template`]})
      platformVersion = await registry.latestPlatformVersion()
      if (!platformVersion) {
        this.error('could not resolve the @reactivapp/mobile version from the registry — run `reactiv whoami` to check your login')
      }
      const peers = await registry.platformManifestField(platformVersion, 'peerDependencies')
      reactVersion = peers.react
      reactNativeVersion = peers['react-native']
      if (!reactVersion || !reactNativeVersion) {
        this.error('could not resolve @reactivapp/mobile version/peers from the registry — run `reactiv whoami` to check your login')
      }
      const platformDependencies = await registry.platformManifestField(platformVersion, 'dependencies')
      if (PLATFORM_PACKAGES.includes(appSlug) || Object.hasOwn(platformDependencies, appSlug) || Object.hasOwn(peers, appSlug)) {
        this.error(`the merchant slug "${appSlug}" is a package name the platform already uses — contact Reactiv`)
      }

      // Download the template via npm so the transcript shows the registry URL.
      this.log('Downloading @reactivapp/app-template…')
      const templateDir = await registry.fetchTemplate()

      try {
        for (const name of fs.readdirSync(templateDir)) createdEntries.add(expandedName(name))
        fileCount = expandTemplate(templateDir, targetDir, {
          appName: appSlug,
          appSlug,
          appUuid,
          bundleIdentifier: flags['bundle-id'] ?? defaultBundleIdentifier(appSlug),
          platformVersion,
          reactVersion,
          reactNativeVersion,
        })

        if (!fs.existsSync(path.join(targetDir, APP_DIR, 'package.json')) || !fs.existsSync(path.join(targetDir, 'src'))) {
          throw new Error(
            `the downloaded @reactivapp/app-template has no ${APP_DIR}/ shell or src/ library — it predates the library layout this CLI expects; ask Reactiv to publish the current template`,
          )
        }
        const ownDeps = Object.assign(
          {},
          ...[path.join(targetDir, 'package.json'), path.join(targetDir, APP_DIR, 'package.json')].flatMap(manifestPath => {
            const manifest = readManifest(manifestPath)
            return [manifest.dependencies, manifest.devDependencies]
          }),
        ) as Record<string, unknown>
        if (Object.hasOwn(ownDeps, appSlug)) {
          throw new Error(`the merchant slug "${appSlug}" is a package name the project itself installs — contact Reactiv`)
        }

        run('git', ['init', '--quiet'], {cwd: targetDir})
        assertNpmrcIgnored(targetDir)

        assertSameRegistries(registry, await ensureRegistryAuth(ctx, targetDir))

        if (!flags['skip-install']) {
          this.log('Installing library dependencies (npm, root)…')
          await installWithRegistryAuth(ctx, registry, targetDir, targetDir)
          if (!fs.existsSync(path.join(targetDir, 'node_modules', '@reactivapp', 'mobile', 'package.json'))) {
            this.warn('the root install did not add the @reactivapp/mobile peer (is legacy-peer-deps set in your npm config?) — editor types and `npm run typecheck` need it; the app still runs')
          }
          this.log(`Installing app shell dependencies (npm, ${APP_DIR}/)…`)
          await installWithRegistryAuth(ctx, registry, targetDir, path.join(targetDir, APP_DIR))
          const skipped = skippedInstallScripts(path.join(targetDir, APP_DIR))
          if (skipped.length > 0) {
            this.warn(`install scripts were not run in ${APP_DIR}/ for: ${skipped.join(', ')} — run \`npm rebuild\` in ${APP_DIR}/ if the app fails to build`)
          }
        }

        run('git', ['add', '-A'], {cwd: targetDir})
        assertNoNpmrcStaged(targetDir)
        run('git', ['commit', '--quiet', '-m', 'Initial scaffold from @reactivapp/app-template'], {cwd: targetDir})
      } catch (error) {
        // A half-initialized scaffold would block every re-run with
        // "already exists and is not empty" — clean up what this run created.
        if (!targetExistedBefore) {
          fs.rmSync(targetDir, {recursive: true, force: true})
          this.warn(`scaffold failed — removed partial project at ${targetDir}; fix the cause and re-run`)
        } else {
          try {
            for (const entry of createdEntries) fs.rmSync(path.join(targetDir, entry), {recursive: true, force: true})
            this.warn(`scaffold failed — removed what this run created in ${targetDir}; check it before re-running`)
          } catch (cleanupError) {
            this.warn(`scaffold failed and ${targetDir} could not be cleaned (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}) — remove what this run created before re-running`)
          }
        }
        throw error
      }
    } catch (error) {
      reportAuthError(this, error)
    } finally {
      fs.rmSync(workDir, {recursive: true, force: true})
    }

    renderSuccess({
      headline: `Scaffolded ${appSlug}`,
      body: [
        `${fileCount} files expanded to ${targetDir}`,
        `library: package.json + src/ (what gets submitted); runnable shell: ${APP_DIR}/`,
        `platform @reactivapp/mobile@${platformVersion} (react ${reactVersion}, react-native ${reactNativeVersion})`,
      ],
      nextSteps: [`cd ${appSlug}`, 'reactiv app run ios'],
    })
  }
}
