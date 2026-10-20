import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {gitProbeEnv} from './auth/npmrc'

export const APP_DIR = 'app'
export const LIBRARY_SOURCE_DIR = 'src'

export const PLATFORM_PACKAGES = ['@reactivapp/mobile', 'react', 'react-native']

export interface Manifest {
  name?: unknown
  dependencies?: Record<string, string>
  [key: string]: unknown
}

export interface ProjectLayout {
  root: string
  appDir: string
}

export const readManifest = (manifestPath: string): Manifest => {
  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch {
    throw new Error(`${manifestPath} not found — this is not a library-layout Reactiv Plus project`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${manifestPath} is not valid JSON (${message})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${manifestPath} must contain a JSON object`)
  }
  return parsed as Manifest
}

export const assertNpmrcFilesIgnored = (root: string): void => {
  const inWorkTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {cwd: root, encoding: 'utf8', env: gitProbeEnv()})
  if (inWorkTree.status !== 0 || inWorkTree.stdout.trim() !== 'true') return
  const exposed = [root, path.join(root, APP_DIR)]
    .filter(dir => fs.existsSync(path.join(dir, 'package.json')))
    .map(dir => path.relative(root, path.join(dir, '.npmrc')))
    .filter(relative => spawnSync('git', ['check-ignore', '-q', '--', relative], {cwd: root, stdio: 'ignore', env: gitProbeEnv()}).status !== 0)
  if (exposed.length > 0) {
    throw new Error(`.gitignore does not ignore ${exposed.join(' and ')} — add ".npmrc" (no leading slash) to .gitignore so a registry token can never be committed`)
  }
}

export const resolveLayout = (root: string): ProjectLayout => {
  const appDir = path.join(root, APP_DIR)
  if (!fs.existsSync(path.join(appDir, 'package.json'))) {
    const legacy = fs.existsSync(path.join(root, 'custom'))
    throw new Error(
      legacy
        ? 'this project uses the old layout (custom/ next to ios/) — scaffold a fresh project with `reactiv app init` and move custom/ into its src/'
        : `${APP_DIR}/package.json not found — run this from the project root (the directory holding reactiv.conf.js and the ${APP_DIR}/ shell)`,
    )
  }
  return {root, appDir}
}

export interface DependencyDrift {
  name: string
  library?: string
  app?: string
  platformShipped?: boolean
  platformPeer?: boolean
  installed?: string
}

const specsOf = (value: unknown, label: string): Record<string, string> => {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec !== 'string' || spec.trim() === '') throw new Error(`${label} "${name}" must be a version string`)
  }
  return value as Record<string, string>
}

const dependenciesOf = (manifest: Manifest, label: string): Record<string, string> =>
  specsOf(manifest.dependencies, `${label} "dependencies"`)

const peersOf = (manifest: Manifest): Record<string, string> => specsOf(manifest.peerDependencies, 'package.json "peerDependencies"')

const has = (record: Record<string, string>, name: string): boolean => Object.hasOwn(record, name)

export interface PlatformPackages {
  shipped: ReadonlySet<string>
  peers: ReadonlySet<string>
}

export const findDependencyDrift = (
  library: Manifest,
  app: Manifest,
  platform: PlatformPackages = {shipped: new Set(), peers: new Set()},
): DependencyDrift[] => {
  const libraryPeers = peersOf(library)
  const libraryDeps = dependenciesOf(library, 'package.json')
  const appDeps = dependenciesOf(app, `${APP_DIR}/package.json`)
  const drift: DependencyDrift[] = []
  for (const [name, spec] of Object.entries(libraryDeps)) {
    if (PLATFORM_PACKAGES.includes(name)) continue
    if (appDeps[name] !== spec || !has(appDeps, name)) drift.push({name, library: spec, app: has(appDeps, name) ? appDeps[name] : undefined})
  }
  for (const [name, spec] of Object.entries(appDeps)) {
    if (PLATFORM_PACKAGES.includes(name) || has(libraryDeps, name)) continue
    if (platform.peers.has(name) && !platform.shipped.has(name)) {
      if (!has(libraryPeers, name)) drift.push({name, app: spec, platformPeer: true})
      continue
    }
    drift.push(platform.shipped.has(name) ? {name, app: spec, platformShipped: true} : {name, app: spec})
  }
  return drift.sort((a, b) => a.name.localeCompare(b.name))
}

export const formatDependencyDrift = (drift: DependencyDrift[]): string => {
  const lines = drift.map(({name, library, app, platformShipped, platformPeer, installed}) => {
    if (platformPeer) {
      return `  ${name}: the platform expects the app to provide it — run \`npm install\` in ${APP_DIR}/, keep it in ${APP_DIR}/package.json and add its installed exact version ("${installed ?? app}" now) to package.json peerDependencies`
    }
    if (platformShipped) {
      return `  ${name}: the platform already ships it — remove it from ${APP_DIR}/package.json (declare it in package.json peerDependencies if src/ imports it)`
    }
    if (library === undefined) {
      return `  ${name}: in ${APP_DIR}/package.json only — add "${name}": "${app}" to the root package.json dependencies (it ships with the submission), or remove it from ${APP_DIR}/package.json`
    }
    if (app === undefined) {
      return `  ${name}: missing from ${APP_DIR}/package.json — add "${name}": "${library}" to its dependencies`
    }
    return `  ${name}: "${library}" in package.json but "${app}" in ${APP_DIR}/package.json — set ${APP_DIR}/package.json to "${library}"`
  })
  return [
    `${APP_DIR}/package.json dependencies are out of sync with the library's package.json:`,
    ...lines,
    `then run \`npm install\` in ${APP_DIR}/ (native modules only autolink from ${APP_DIR}/package.json)`,
  ].join('\n')
}

export interface PeerDrift {
  name: string
  library?: string
  app?: string
}

export const findPeerDrift = (library: Manifest, app: Manifest): PeerDrift[] => {
  const peers = peersOf(library)
  const appDeps = dependenciesOf(app, `${APP_DIR}/package.json`)
  return PLATFORM_PACKAGES.filter(name => !has(peers, name) || !has(appDeps, name) || peers[name] !== appDeps[name]).map(name => ({
    name,
    library: has(peers, name) ? peers[name] : undefined,
    app: has(appDeps, name) ? appDeps[name] : undefined,
  }))
}

export const formatPeerDrift = (drift: PeerDrift[]): string =>
  [
    `package.json peerDependencies do not match the platform ${APP_DIR}/package.json runs:`,
    ...drift.map(({name, library, app}) => {
      if (app === undefined && library === undefined) return `  ${name}: missing from both — the scaffold declares it in both manifests; restore it from a fresh \`reactiv app init\``
      if (app === undefined) return `  ${name}: missing from ${APP_DIR}/package.json — add "${name}": "${library}" to its dependencies`
      return `  ${name}: peer "${library ?? '(none)'}" but ${APP_DIR}/package.json has "${app}" — set package.json peerDependencies.${name} to "${app}"`
    }),
  ].join('\n')

export interface DevTrioDrift {
  name: string
  peer: string
  dev: string
}

export const findDevTrioDrift = (library: Manifest): DevTrioDrift[] => {
  const peers = peersOf(library)
  const dev = specsOf(library.devDependencies, 'package.json "devDependencies"')
  return PLATFORM_PACKAGES.filter(name => has(dev, name) && has(peers, name) && dev[name] !== peers[name]).map(name => ({name, peer: peers[name], dev: dev[name]}))
}

export const formatDevTrioDrift = (drift: DevTrioDrift[]): string =>
  [
    'package.json devDependencies do not match its peerDependencies, so the typecheck runs against a different platform than the app:',
    ...drift.map(({name, peer, dev}) => `  ${name}: devDependencies "${dev}" but peerDependencies "${peer}" — set devDependencies.${name} to "${peer}" and run \`npm install\` at the project root`),
  ].join('\n')

const readPlatformManifest = (layout: ProjectLayout): Manifest => {
  const manifestPath = path.join(layout.appDir, 'node_modules', '@reactivapp', 'mobile', 'package.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`@reactivapp/mobile is not installed in ${APP_DIR}/ — run \`npm install\` in ${APP_DIR}/`)
  }
  return readManifest(manifestPath)
}

const readPlatformAliases = (layout: ProjectLayout): string[] => {
  const file = path.join(layout.appDir, 'node_modules', '@reactivapp', 'mobile', 'toolchain', 'aliases.json')
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw new Error(`${file} could not be read (${code ?? 'unknown error'}) — reinstall @reactivapp/mobile in ${APP_DIR}/`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${file} is not valid JSON — reinstall @reactivapp/mobile in ${APP_DIR}/`)
  }
  const aliases = (parsed as {libAliases?: unknown} | null)?.libAliases
  if (typeof aliases !== 'object' || aliases === null || Array.isArray(aliases)) {
    throw new Error(`${file} has no "libAliases" object — reinstall @reactivapp/mobile in ${APP_DIR}/`)
  }
  const names = Object.keys(aliases)
  const malformed = names.filter(name => !/^@[a-z0-9-]+$/.test(name))
  if (malformed.length > 0) {
    throw new Error(`${file} lists alias names that are not scope-shaped (${malformed.join(', ')}) — reinstall @reactivapp/mobile in ${APP_DIR}/`)
  }
  return names
}

const platformShipped = (platform: Manifest): Set<string> =>
  new Set([...PLATFORM_PACKAGES, ...Object.keys(specsOf(platform.dependencies, '@reactivapp/mobile "dependencies"'))])

const platformSupplied = (platform: Manifest): Set<string> =>
  new Set([
    ...PLATFORM_PACKAGES,
    ...Object.keys(specsOf(platform.dependencies, '@reactivapp/mobile "dependencies"')),
    ...Object.keys(specsOf(platform.peerDependencies, '@reactivapp/mobile "peerDependencies"')),
  ])

export const readPlatformSupplied = (layout: ProjectLayout): ReadonlySet<string> =>
  new Set([...platformSupplied(readPlatformManifest(layout)), ...readPlatformAliases(layout)])

export const readLibraryDependencies = (layout: ProjectLayout): Record<string, string> =>
  dependenciesOf(readManifest(path.join(layout.root, 'package.json')), 'package.json')

const plural = (names: string[], one: string, many: string): string => (names.length === 1 ? one : many)

const installedVersion = (manifestPath: string): string | undefined => {
  if (!fs.existsSync(manifestPath)) return undefined
  const {version} = readManifest(manifestPath)
  if (typeof version !== 'string' || version === '') {
    throw new Error(`${manifestPath} has no version — the install is damaged; run \`npm install\` in ${APP_DIR}/`)
  }
  return version
}

const nestedPlatformCopy = (layout: ProjectLayout, name: string): string =>
  path.join(layout.appDir, 'node_modules', '@reactivapp', 'mobile', 'node_modules', name, 'package.json')

export const assertDependenciesInSync = (layout: ProjectLayout): void => {
  const library = readManifest(path.join(layout.root, 'package.json'))
  const app = readManifest(path.join(layout.appDir, 'package.json'))
  const libraryDeps = dependenciesOf(library, 'package.json')
  const platform = readPlatformManifest(layout)
  const supplied = platformSupplied(platform)
  const shippedByPlatform = platformShipped(platform)
  const appDepsOfShell = dependenciesOf(app, `${APP_DIR}/package.json`)
  const misplaced = Object.keys(libraryDeps).filter(name => supplied.has(name))
  if (misplaced.length > 0) {
    throw new Error(
      [
        'package.json dependencies include packages the platform provides:',
        ...misplaced.map(name => {
          if (PLATFORM_PACKAGES.includes(name)) {
            return `  ${name}: remove it from package.json dependencies — it stays in peerDependencies and ${APP_DIR}/package.json`
          }
          if (shippedByPlatform.has(name)) {
            return `  ${name}: the platform already ships it, so a second copy would be bundled — move it to peerDependencies and remove it from ${APP_DIR}/package.json`
          }
          return has(appDepsOfShell, name)
            ? `  ${name}: the platform expects the app to provide it — move it to peerDependencies and keep it in ${APP_DIR}/package.json`
            : `  ${name}: the platform expects the app to provide it — move it to peerDependencies and add "${name}": "${libraryDeps[name]}" to ${APP_DIR}/package.json dependencies`
        }),
      ].join('\n'),
    )
  }
  const drift = findDependencyDrift(library, app, {shipped: shippedByPlatform, peers: supplied}).map(entry =>
    entry.platformPeer ? {...entry, installed: installedVersion(path.join(layout.appDir, 'node_modules', entry.name, 'package.json'))} : entry,
  )
  if (drift.length > 0) throw new Error(formatDependencyDrift(drift))
  const unlistedPeers = Object.entries(peersOf(library)).filter(
    ([name]) => supplied.has(name) && !shippedByPlatform.has(name) && !has(appDepsOfShell, name),
  )
  if (unlistedPeers.length > 0) {
    throw new Error(
      [
        `${APP_DIR}/package.json must list the peers the app provides (native modules only autolink from there):`,
        ...unlistedPeers.map(([name, spec]) => `  ${name}: add "${name}": "${spec}" to ${APP_DIR}/package.json dependencies`),
        `then run \`npm install\` in ${APP_DIR}/`,
      ].join('\n'),
    )
  }
  const peerDrift = findPeerDrift(library, app)
  if (peerDrift.length > 0) throw new Error(formatPeerDrift(peerDrift))
  const devTrioDrift = findDevTrioDrift(library)
  if (devTrioDrift.length > 0) throw new Error(formatDevTrioDrift(devTrioDrift))
  const nestedFixes = Object.entries(libraryDeps).flatMap(([name, spec]) => {
    const nested = installedVersion(nestedPlatformCopy(layout, name))
    if (nested === undefined) return []
    const hoisted = installedVersion(path.join(layout.appDir, 'node_modules', name, 'package.json'))
    if (hoisted === nested) return [`${name}: both copies are ${nested} — run \`npm dedupe\` in ${APP_DIR}/ so one copy remains`]
    if (nested === spec) return [`${name}: run \`npm install\` and then \`npm dedupe\` in ${APP_DIR}/ so one ${nested} copy remains`]
    return [`${name}: the platform uses ${nested} — pin package.json and ${APP_DIR}/package.json to "${nested}" (now "${spec}"), then run \`npm install\` and \`npm dedupe\` in ${APP_DIR}/`]
  })
  if (nestedFixes.length > 0) {
    throw new Error(
      `the platform keeps its own copy under ${APP_DIR}/node_modules/@reactivapp/mobile/node_modules, so two copies would be bundled:\n${nestedFixes.map(line => `  ${line}`).join('\n')}`,
    )
  }
  const appDeps = appDepsOfShell
  const staleTrio = PLATFORM_PACKAGES.filter(name => {
    const version = installedVersion(path.join(layout.appDir, 'node_modules', name, 'package.json'))
    return EXACT_VERSION.test(appDeps[name]) && version !== undefined && version !== appDeps[name]
  })
  if (staleTrio.length > 0) {
    throw new Error(`${APP_DIR}/node_modules does not hold the ${staleTrio.map(name => `${name}@${appDeps[name]}`).join(', ')} that ${APP_DIR}/package.json declares — run \`npm install\` in ${APP_DIR}/`)
  }
  const notInstalled = [...PLATFORM_PACKAGES.filter(name => name !== '@reactivapp/mobile'), ...Object.keys(libraryDeps)].filter(
    name => !fs.existsSync(path.join(layout.appDir, 'node_modules', name, 'package.json')),
  )
  if (notInstalled.length > 0) {
    throw new Error(`${notInstalled.join(', ')} ${plural(notInstalled, 'is', 'are')} declared but not installed in ${APP_DIR}/ — run \`npm install\` in ${APP_DIR}/`)
  }
}

const NON_REGISTRY_SPEC = /^[a-z+]+:|^\.|\//i
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const RESERVED_SCOPES = ['@reactivapp/', '@reactiv-submissions/']

export const assertSubmittableDependencies = (layout: ProjectLayout): void => {
  const library = readManifest(path.join(layout.root, 'package.json'))
  const libraryDeps = dependenciesOf(library, 'package.json')
  const reserved = Object.keys(libraryDeps).filter(name => RESERVED_SCOPES.some(scope => name.startsWith(scope)))
  if (reserved.length > 0) {
    throw new Error(`package.json dependencies cannot include ${reserved.join(', ')} — packages in ${RESERVED_SCOPES.join(' and ')} are never submission dependencies`)
  }
  const nonRegistry = Object.entries(libraryDeps).filter(([, spec]) => NON_REGISTRY_SPEC.test(spec))
  if (nonRegistry.length > 0) {
    throw new Error(
      `package.json dependencies must be registry versions — a submission cannot carry ${nonRegistry.map(([name, spec]) => `${name}@${spec}`).join(', ')}; publish the package to a registry or copy its source into src/`,
    )
  }
  const unpinned = Object.entries(libraryDeps).filter(([, spec]) => !EXACT_VERSION.test(spec))
  if (unpinned.length > 0) {
    throw new Error(
      `package.json dependencies must be exact versions (review approves exactly what installs) — pin ${unpinned.map(([name, spec]) => `${name} (now "${spec}")`).join(', ')} in package.json and ${APP_DIR}/package.json, e.g. \`npm install --save-exact <name>@<version>\` in both`,
    )
  }
  const app = readManifest(path.join(layout.appDir, 'package.json'))
  if (app.overrides !== undefined) {
    throw new Error(`${APP_DIR}/package.json "overrides" cannot be submitted alongside — the merchant build installs the library's declared versions only; remove the overrides and test again`)
  }
  const stale = Object.entries(libraryDeps).filter(([name, spec]) => {
    const manifestPath = path.join(layout.appDir, 'node_modules', name, 'package.json')
    return installedVersion(manifestPath) !== spec || readManifest(manifestPath).name !== name
  })
  if (stale.length > 0) {
    throw new Error(`${APP_DIR}/node_modules does not hold the declared versions of ${stale.map(([name, spec]) => `${name}@${spec}`).join(', ')} — run \`npm install\` in ${APP_DIR}/ and test again before submitting`)
  }
  const platform = readPlatformManifest(layout)
  const supplied = platformSupplied(platform)
  const shippedByPlatform = platformShipped(platform)
  const peers = peersOf(library)
  const unsuppliedPeers = Object.keys(peers).filter(name => !supplied.has(name))
  if (unsuppliedPeers.length > 0) {
    throw new Error(
      `package.json peerDependencies ${unsuppliedPeers.join(', ')} ${plural(unsuppliedPeers, 'is', 'are')} not supplied by the platform, so nothing would install ${plural(unsuppliedPeers, 'it', 'them')} — move ${plural(unsuppliedPeers, 'it', 'them')} to dependencies`,
    )
  }
  const peerFixes = Object.entries(peers).flatMap(([name, spec]) => {
    if (PLATFORM_PACKAGES.includes(name)) return []
    const hoisted = installedVersion(path.join(layout.appDir, 'node_modules', name, 'package.json'))
    const nested = installedVersion(nestedPlatformCopy(layout, name))
    if (hoisted !== undefined && nested !== undefined && hoisted !== nested) {
      const fix = shippedByPlatform.has(name)
        ? `run \`npm ls ${name}\` in ${APP_DIR}/ to find the library dependency that pulls in ${hoisted}; pin a version of it compatible with ${nested} or remove it, then run \`npm dedupe\``
        : `set ${APP_DIR}/package.json to "${nested}" and run \`npm install\` and \`npm dedupe\` in ${APP_DIR}/`
      return [`${name}: two copies in ${APP_DIR}/ (${hoisted} for src/, ${nested} for the platform) — ${fix}`]
    }
    const version = hoisted ?? nested
    if (version === undefined) return [`${name}: not installed in ${APP_DIR}/ — run \`npm install\` in ${APP_DIR}/`]
    return spec === version ? [] : [`${name}: "${spec}" — set it to "${version}", the version the platform uses`]
  })
  if (peerFixes.length > 0) {
    throw new Error(`package.json peerDependencies must name the exact version the platform uses:\n${peerFixes.map(line => `  ${line}`).join('\n')}`)
  }
  const lockfilePath = path.join(layout.appDir, 'package-lock.json')
  if (!fs.existsSync(lockfilePath)) {
    throw new Error(`${APP_DIR}/package-lock.json not found — run \`npm install\` (npm 7 or later) in ${APP_DIR}/ and test again before submitting`)
  }
  const lockfile = readManifest(lockfilePath) as {packages?: Record<string, {version?: string}>}
  const lockedPlatform = lockfile.packages?.['node_modules/@reactivapp/mobile']?.version
  if (lockfile.packages === undefined) {
    throw new Error(`${APP_DIR}/package-lock.json predates npm 7 — run \`npm install\` with npm 7 or later in ${APP_DIR}/`)
  }
  if (lockedPlatform === undefined) {
    throw new Error(`${APP_DIR}/package-lock.json records no installed @reactivapp/mobile — run \`npm install\` in ${APP_DIR}/`)
  }
  const loosePlatformPeers = PLATFORM_PACKAGES.filter(name => !EXACT_VERSION.test(peers[name] ?? ''))
  if (loosePlatformPeers.length > 0) {
    throw new Error(
      `package.json peerDependencies ${loosePlatformPeers.join(', ')} must be exact versions (the submission records the platform it was built against) — set them, and ${APP_DIR}/package.json, to the installed versions`,
    )
  }
  if (platform.version !== lockedPlatform) {
    throw new Error(`${APP_DIR}/node_modules holds @reactivapp/mobile@${String(platform.version)} but ${APP_DIR}/package-lock.json records ${lockedPlatform} — run \`npm install\` in ${APP_DIR}/ and test again before submitting`)
  }
}
