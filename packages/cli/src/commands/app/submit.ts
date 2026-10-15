import {Command, Flags} from '@oclif/core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {createAuthContext, reportAuthError} from '../../lib/auth/context.js'
import {SUBMISSIONS_SCOPE} from '../../lib/auth/npmrc.js'
import {ensureRegistryAuth, refreshAfterRegistryAuthError, type RegistryAuth, takeRegistryRetry} from '../../lib/auth/token.js'
import {assertImportsDeclared, type DeclaredPackages, readDeclaredPackages} from '../../lib/imports.js'
import {
  assertDependenciesInSync,
  assertNpmrcFilesIgnored,
  assertSubmittableDependencies,
  LIBRARY_SOURCE_DIR,
  type ProjectLayout,
  readManifest,
  resolveLayout,
} from '../../lib/layout.js'
import {assertNoAppNativeIntegration} from '../../lib/native-integration.js'
import {capture, captureAll, isRegistryAuthError, NPM_LOGLEVEL, npmEnv, runTee} from '../../lib/npm.js'
import {loadProjectIdentity, type ProjectIdentity} from '../../lib/project.js'
import {findSecretsInDirectory, formatSecretFindings} from '../../lib/secret-scan.js'
import {
  assertLibraryManifest,
  assertReExportTargetsPacked,
  buildSubmissionManifest,
  DEFAULT_SIZE_CAP_MB,
  assertTarballContents,
  checkSizeCap,
  computeSha256,
  draftBaseVersion,
  findEntryInTarball,
  findForbiddenPaths,
  isIgnoredOsFile,
  nextDraftVersion,
  readPlatformVersionFromLockfile,
  resolveExistingVersions,
  validateEntryPointSource,
} from '../../lib/submission.js'

interface PackEntry {
  path: string
  size: number
}

interface PackResult {
  filename: string
  files: PackEntry[]
  unpackedSize: number
}

export class AppSubmit extends Command {
  static override description =
    'Pack the library at the project root (package.json + src/) and publish it to the submissions registry with dist-tag draft'

  static override flags = {
    'max-size-mb': Flags.integer({description: 'maximum unpacked size in MB', default: DEFAULT_SIZE_CAP_MB, min: 1}),
    'dry-run': Flags.boolean({description: 'run everything including pack but skip the actual publish', default: false}),
  }

  async run(): Promise<void> {
    const {renderSuccess, renderInfo} = await import('@reactivapp/cli-ui')
    const {flags} = await this.parse(AppSubmit)
    const projectRoot = process.cwd()

    if (!fs.existsSync(path.join(projectRoot, 'reactiv.conf.js'))) {
      this.error('not a Reactiv Plus project (reactiv.conf.js not found) — run this from the project root')
    }

    let project: ProjectIdentity
    try {
      project = loadProjectIdentity(projectRoot)
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error))
    }
    const {appUuid, appName, slug: merchantSlug} = project

    let layout: ProjectLayout
    let library: Record<string, unknown>
    let entryPath: string
    let platformVersion: string
    try {
      layout = resolveLayout(projectRoot)
      library = readManifest(path.join(projectRoot, 'package.json'))
      entryPath = assertLibraryManifest(library)
      assertDependenciesInSync(layout)
      assertSubmittableDependencies(layout)
      assertNoAppNativeIntegration(layout)
      platformVersion = readPlatformVersionFromLockfile(layout.appDir)
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error))
    }
    const sourceDir = path.join(projectRoot, LIBRARY_SOURCE_DIR)
    if (!fs.existsSync(sourceDir) || (!fs.lstatSync(sourceDir).isSymbolicLink() && !fs.lstatSync(sourceDir).isDirectory())) {
      this.error(`${LIBRARY_SOURCE_DIR}/ not found — the library source lives in a ${LIBRARY_SOURCE_DIR}/ directory at the project root`)
    }

    const reportForbidden = (dir: string): void => {
      const forbidden = findForbiddenPaths(dir)
      if (forbidden.length > 0) {
        this.error(
          `forbidden content found in ${LIBRARY_SOURCE_DIR}/ — remove these entries before submitting:\n${forbidden.map(f => `  ${f}`).join('\n')}`,
        )
      }
    }
    reportForbidden(sourceDir)
    const entryFile = path.join(projectRoot, entryPath)
    if (!fs.existsSync(entryFile) || !fs.statSync(entryFile).isFile()) {
      this.error(`entry point ${entryPath} (the package.json "react-native"/"main" entry) not found — create it and export CustomCompositions + registerCustomComponents`)
    }
    let declaredPackages: DeclaredPackages
    let importWarnings: string[]
    try {
      validateEntryPointSource(fs.readFileSync(entryFile, 'utf8'), path.basename(entryFile))
      declaredPackages = readDeclaredPackages(layout)
      importWarnings = assertImportsDeclared(projectRoot, declaredPackages)
      assertNpmrcFilesIgnored(projectRoot)
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error))
    }
    for (const warning of importWarnings) this.warn(warning)

    const ctx = createAuthContext(this)
    let auth: RegistryAuth
    try {
      auth = await ensureRegistryAuth(ctx, projectRoot)
    } catch (error) {
      return reportAuthError(this, error)
    }
    const refreshOnce = async (output: string): Promise<boolean> => {
      if (!isRegistryAuthError(output) || !takeRegistryRetry(ctx)) return false
      auth = await refreshAfterRegistryAuthError(ctx, projectRoot)
      return true
    }
    const scopeFlag = `--${SUBMISSIONS_SCOPE}:registry=`
    const withCurrentRegistry = (args: string[]): string[] =>
      args.map(arg => (arg.startsWith(scopeFlag) ? `${scopeFlag}${auth.registryUrl}` : arg))
    const packageName = `@reactiv-submissions/${merchantSlug}`

    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reactiv-submit-'))
    try {
      let stagedForbidden: string[]
      try {
        fs.cpSync(sourceDir, path.join(stagingDir, LIBRARY_SOURCE_DIR), {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          filter: source => !isIgnoredOsFile(path.basename(source)),
        })
        stagedForbidden = findForbiddenPaths(path.join(stagingDir, LIBRARY_SOURCE_DIR))
      } catch (error) {
        this.error(`could not stage ${LIBRARY_SOURCE_DIR}/ (it changed while submitting?): ${error instanceof Error ? error.message : String(error)}`)
      }
      if (stagedForbidden.length > 0) {
        this.error(
          `forbidden content found in ${LIBRARY_SOURCE_DIR}/ — remove these entries before submitting:\n${stagedForbidden.map(f => `  ${f}`).join('\n')}`,
        )
      }

      const version = nextDraftVersion(
        await resolveExistingVersions(packageName, auth.registryUrl, async (command, args) => {
          const result = captureAll(command, args, {env: npmEnv()})
          if (result.status !== 0 && (await refreshOnce(result.stderr + result.stdout))) {
            return captureAll(command, withCurrentRegistry(args), {env: npmEnv()})
          }
          return result
        }),
      )
      const registryUrl = auth.registryUrl

      const packageJson = buildSubmissionManifest(library, {
        name: packageName,
        version,
        appName,
        reactivPlus: {appUuid, merchantSlug, platformVersion},
      })
      fs.writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n')

      // Published versions are immutable: nothing credential-bearing may be packed.
      const secretFindings = findSecretsInDirectory(stagingDir)
      if (secretFindings.length > 0) {
        this.error(formatSecretFindings(secretFindings))
      }

      let stagedWarnings: string[]
      try {
        stagedWarnings = assertImportsDeclared(stagingDir, declaredPackages)
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error))
      }
      for (const warning of stagedWarnings.filter(warning => !importWarnings.includes(warning))) this.warn(warning)

      // Pack a real tarball — the artifact-truth checks validate THESE bytes.
      const packOutput = capture('npm', ['pack', '--json', '--ignore-scripts', '--loglevel', 'warn'], {cwd: stagingDir, env: npmEnv()})
      const parsed = JSON.parse(packOutput) as PackResult[] | PackResult
      const packResult = Array.isArray(parsed) ? parsed[0] : parsed
      if (!packResult?.filename) this.error('npm pack produced no tarball — check your npm version')
      const tarballPath = path.join(stagingDir, packResult.filename)

      // Derive all validated facts from the tarball, not the source tree.
      const tarListOutput = capture('tar', ['-tzf', tarballPath])
      const tarEntries = tarListOutput.split('\n').filter(Boolean)
      assertTarballContents(tarEntries, entryPath)

      const entryTarPath = findEntryInTarball(tarEntries, entryPath)
      const entryContent = capture('tar', ['-xzf', tarballPath, '-O', entryTarPath])
      const contract = validateEntryPointSource(entryContent, path.basename(entryTarPath))
      // A retained index whose re-export targets were excluded would pass the
      // entry check yet ship an unusable package.
      const strippedEntries = tarEntries.map(e => e.replace(/^package\//, ''))
      assertReExportTargetsPacked(contract.reExportSpecifiers, strippedEntries, entryPath)

      if (typeof packResult.unpackedSize !== 'number') {
        this.error('npm pack --json did not report unpackedSize — cannot enforce the size cap; check your npm version')
      }
      checkSizeCap(packResult.unpackedSize, flags['max-size-mb'])

      const sha256 = computeSha256(tarballPath)
      const receipt = [
        `${packageName}@${version}`,
        `review cycle ${draftBaseVersion(version)} (approval will publish ${draftBaseVersion(version)})`,
        `appUuid ${appUuid}`,
        `dependencies ${Object.keys((packageJson.dependencies as Record<string, string> | undefined) ?? {}).join(', ') || 'none'}`,
        `dist-tag draft`,
        `registry ${registryUrl}`,
        `sha256 ${sha256}`,
      ]

      if (flags['dry-run']) {
        renderInfo({
          headline: 'Dry run complete (publish skipped)',
          body: receipt,
        })
        return
      }

      // Publish the same tarball bytes that were validated above.
      const publishArgs = () => [
        'publish', tarballPath, '--tag', 'draft', `--${SUBMISSIONS_SCOPE}:registry=${auth.registryUrl}`, '--loglevel', NPM_LOGLEVEL,
      ]
      let publish = await runTee('npm', publishArgs(), {cwd: projectRoot, env: npmEnv()})
      if (publish.status !== 0 && (await refreshOnce(publish.stderr))) {
        // The version was allocated against the old registry; never publish it somewhere else.
        if (auth.registryUrl !== registryUrl) {
          this.error('The submissions registry changed while publishing; nothing was published. Run `reactiv app submit` again.')
        }
        publish = await runTee('npm', publishArgs(), {cwd: projectRoot, env: npmEnv()})
      }
      if (publish.status !== 0) {
        this.error(`the registry rejected the publish — npm publish exited with ${publish.status}`)
      }

      renderSuccess({
        headline: 'Submission published',
        body: receipt,
      })
    } catch (error) {
      reportAuthError(this, error)
    } finally {
      fs.rmSync(stagingDir, {recursive: true, force: true})
    }
  }
}
