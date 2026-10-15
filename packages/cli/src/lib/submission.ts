import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

import {SUBMISSIONS_SCOPE} from './auth/npmrc.js'
import {APP_DIR} from './layout.js'
import {captureAll, type CaptureAllResult, NPM_LOGLEVEL, npmEnv} from './npm.js'

export const DEFAULT_SIZE_CAP_MB = 5

export const readPlatformVersionFromLockfile = (appDir: string): string => {
  const lockfilePath = path.join(appDir, 'package-lock.json')
  if (!fs.existsSync(lockfilePath)) {
    throw new Error(`${APP_DIR}/package-lock.json not found — run npm install in ${APP_DIR}/ first`)
  }
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8')) as {
    packages?: Record<string, {version?: string}>
  }
  const entry = lockfile.packages?.['node_modules/@reactivapp/mobile']
  if (!entry?.version) {
    throw new Error(`@reactivapp/mobile not found in ${APP_DIR}/package-lock.json — run npm install in ${APP_DIR}/ first`)
  }
  return entry.version
}

const FORBIDDEN_DIR_NAMES = new Set(['node_modules', 'build', 'dist', 'Pods', '.git', 'DerivedData'])

const isExported = (node: ts.Statement): boolean => {
  if (!ts.canHaveModifiers(node)) return false
  const mods = ts.getModifiers(node)
  return mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

/** Parser-based export-contract check: the source must EXPORT the required public names. */
const hasModifier = (stmt: ts.Statement, kind: ts.SyntaxKind): boolean =>
  (ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) ?? [] : []).some(m => m.kind === kind)

export interface EntryContract {
  reExportSpecifiers: string[]
}

export const REQUIRED_EXPORTS = ['CustomCompositions', 'registerCustomComponents']

export const validateEntryPointSource = (source: string, fileName = 'index.ts'): EntryContract => {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, scriptKind)
  const parseErrors = ts.transpileModule(source, {
    reportDiagnostics: true,
    fileName,
    compilerOptions: {jsx: ts.JsxEmit.Preserve},
  }).diagnostics ?? []
  if (parseErrors.length > 0) {
    const first = parseErrors[0]
    throw new Error(
      `entry point does not parse: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')} — fix the syntax error before submitting`,
    )
  }

  // Only VALUE exports under their public names count: type-only exports and
  // `export default` do not produce the named runtime bindings the platform
  // dispatch imports.
  const exportedNames = new Map<string, string | undefined>()

  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      const from = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : undefined
      for (const el of stmt.exportClause.elements) {
        if (!el.isTypeOnly) exportedNames.set(el.name.text, from)
      }
    }
    if (ts.isVariableStatement(stmt) && isExported(stmt) && !hasModifier(stmt, ts.SyntaxKind.DeclareKeyword)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) exportedNames.set(decl.name.text, undefined)
      }
    }
    if (ts.isFunctionDeclaration(stmt) && isExported(stmt) && stmt.name && !hasModifier(stmt, ts.SyntaxKind.DefaultKeyword) && !hasModifier(stmt, ts.SyntaxKind.DeclareKeyword)) {
      exportedNames.set(stmt.name.text, undefined)
    }
    if (ts.isClassDeclaration(stmt) && isExported(stmt) && stmt.name && !hasModifier(stmt, ts.SyntaxKind.DefaultKeyword) && !hasModifier(stmt, ts.SyntaxKind.DeclareKeyword)) {
      exportedNames.set(stmt.name.text, undefined)
    }
  }

  const missing = REQUIRED_EXPORTS.filter(name => !exportedNames.has(name))
  if (missing.length > 0) {
    throw new Error(
      `entry point must export ${missing.join(' and ')} as named values (type-only and default exports do not count) — add the missing export(s)`,
    )
  }

  const reExportSpecifiers = [...new Set(
    REQUIRED_EXPORTS.map(name => exportedNames.get(name)).filter((f): f is string => typeof f === 'string'),
  )]
  return {reExportSpecifiers}
}

/** Assert every required re-export target exists in the packed file set. */
export const assertReExportTargetsPacked = (specifiers: string[], packedEntries: string[], entryPath = 'src/index.ts'): void => {
  const entrySet = new Set(packedEntries)
  for (const spec of specifiers) {
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      throw new Error(`entry point re-exports from "${spec}" — only relative imports inside src/ are allowed in a submission`)
    }
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), spec))
    if (!base.startsWith('src/')) {
      throw new Error(
        `entry point re-exports from "${spec}", which resolves outside src/ — a submission packs only src/, move the file inside it`,
      )
    }
    const candidates = [
      base, `${base}.ts`, `${base}.tsx`, `${base}.js`,
      `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`,
    ]
    if (!candidates.some(c => entrySet.has(c))) {
      throw new Error(
        `entry point re-exports from "${spec}" but no matching file is in the packed tarball — check for .npmignore rules excluding it`,
      )
    }
  }
}

export const validateEntryPoint = (sourceDir: string): void => {
  const extensions = ['.ts', '.tsx', '.js']
  const indexFile = extensions
    .map(ext => path.join(sourceDir, `index${ext}`))
    .find(p => fs.existsSync(p))
  if (!indexFile) {
    throw new Error(
      'entry point src/index.ts (or .tsx/.js) not found — create it and export CustomCompositions + registerCustomComponents',
    )
  }
  const source = fs.readFileSync(indexFile, 'utf8')
  validateEntryPointSource(source)
}

const isForbiddenName = (name: string): boolean =>
  [...FORBIDDEN_DIR_NAMES].some(f => f.toLowerCase() === name.toLowerCase())

export const isIgnoredOsFile = (name: string): boolean => name === '.DS_Store'

export const findForbiddenPaths = (sourceDir: string): string[] => {
  const forbidden: string[] = []

  if (fs.lstatSync(sourceDir).isSymbolicLink()) {
    forbidden.push('. (symlink — src/ must be a real directory, not a symlink)')
    return forbidden
  }

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const entryPath = path.join(dir, entry.name)
      if (isIgnoredOsFile(entry.name)) {
        continue
      } else if (entry.name.startsWith('.')) {
        forbidden.push(`${path.relative(sourceDir, entryPath)} (hidden — submissions accept no dotfiles)`)
      } else if (entry.isSymbolicLink()) {
        forbidden.push(`${path.relative(sourceDir, entryPath)} (symlink)`)
      } else if (entry.isDirectory()) {
        if (isForbiddenName(entry.name)) {
          forbidden.push(path.relative(sourceDir, entryPath))
        } else {
          walk(entryPath)
        }
      } else if (!entry.isFile()) {
        forbidden.push(`${path.relative(sourceDir, entryPath)} (special file)`)
      } else if (fs.lstatSync(entryPath).nlink > 1) {
        forbidden.push(`${path.relative(sourceDir, entryPath)} (hard link — copy the file instead)`)
      }
    }
  }
  walk(sourceDir)
  return forbidden
}

export const assertPackContents = (files: string[]): void => {
  const bad = files.filter(f => {
    if (f === 'package.json') return false
    const segments = f.split('/')
    if (segments[0] !== 'src') return true
    return segments.some(segment => isForbiddenName(segment) || segment.startsWith('.'))
  })
  if (bad.length > 0) {
    throw new Error(
      `forbidden content in pack output — remove these before submitting:\n${bad.map(f => `  ${f}`).join('\n')}`,
    )
  }
}

export const findEntryInTarball = (entries: string[], entryPath: string): string => {
  const found = `package/${entryPath}`
  if (!entries.includes(found)) {
    throw new Error(
      `entry point ${entryPath} (the package.json "react-native"/"main" entry) not found in the packed tarball — check for .npmignore rules that exclude it`,
    )
  }
  return found
}

/** Validate tarball entries: strip the package/ prefix, check forbidden content, verify the entry point is present. */
export const assertTarballContents = (entries: string[], entryPath: string): void => {
  const stripped = entries.map(e => e.replace(/^package\//, ''))
  assertPackContents(stripped)
  findEntryInTarball(entries, entryPath)
}

const ENTRY_PATTERN = /^src\/index\.(?:ts|tsx|js)$/
const UNSUPPORTED_DEPENDENCY_FIELDS = ['optionalDependencies', 'bundleDependencies', 'bundledDependencies', 'peerDependenciesMeta']

export const assertLibraryManifest = (library: Record<string, unknown>): string => {
  const unsupported = UNSUPPORTED_DEPENDENCY_FIELDS.filter(field => library[field] !== undefined)
  if (unsupported.length > 0) {
    throw new Error(`package.json ${unsupported.join(', ')} cannot be submitted — declare those packages under "dependencies" (and mirror them in ${APP_DIR}/package.json)`)
  }
  if (library.browser !== undefined) {
    throw new Error('package.json "browser" is not supported — Metro would prefer it over "main"; remove it and keep the entry in "react-native" and "main"')
  }
  const {files} = library
  if (!Array.isArray(files) || files.length !== 1 || files[0] !== 'src') {
    throw new Error(`package.json "files" must be exactly ["src"] — a submission packs only the library source (found ${JSON.stringify(files)})`)
  }
  const reactNativeEntry = library['react-native']
  const mainEntry = library.main
  for (const [field, value] of [['react-native', reactNativeEntry], ['main', mainEntry]] as const) {
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`package.json "${field}" must be a path string (the "react-native" field selecting per-file replacements is not supported)`)
    }
  }
  if (typeof reactNativeEntry === 'string' && typeof mainEntry === 'string' && path.posix.normalize(reactNativeEntry) !== path.posix.normalize(mainEntry)) {
    throw new Error(`package.json "react-native" (${reactNativeEntry}) and "main" (${mainEntry}) must point at the same file — Metro reads one, other tooling the other`)
  }
  const declared = (reactNativeEntry ?? mainEntry) as string | undefined
  if (declared === undefined) {
    throw new Error('package.json must declare the library entry: set "main" and "react-native" to "src/index.ts"')
  }
  const entry = path.posix.normalize(declared.replace(/^\.\//, ''))
  if (!ENTRY_PATTERN.test(entry)) {
    throw new Error(`package.json entry "${declared}" must be src/index.ts (or .tsx/.js) — the platform contract and the typecheck read that file`)
  }
  return entry
}

const PRESERVED_FIELDS = ['description', 'main', 'react-native', 'files', 'dependencies']

export interface SubmissionStamp {
  name: string
  version: string
  appName: string
  reactivPlus: {appUuid: string; merchantSlug: string; platformVersion: string}
}

export const buildSubmissionManifest = (library: Record<string, unknown>, stamp: SubmissionStamp): Record<string, unknown> => {
  const manifest: Record<string, unknown> = {name: stamp.name, version: stamp.version}
  for (const field of PRESERVED_FIELDS) {
    if (library[field] !== undefined) manifest[field] = library[field]
  }
  if (typeof manifest.description !== 'string' || manifest.description === '') {
    manifest.description = `Reactiv Plus customization submission for ${stamp.appName}`
  }
  manifest.license = 'UNLICENSED'
  manifest.reactivPlus = stamp.reactivPlus
  return manifest
}

export const checkSizeCap = (unpackedBytes: number, capMb: number): void => {
  const actualMb = unpackedBytes / (1024 * 1024)
  if (actualMb > capMb) {
    throw new Error(
      `size cap exceeded: ${actualMb.toFixed(1)} MB unpacked (cap is ${capMb} MB) — reduce the contents of src/`,
    )
  }
}

export const computeSha256 = (filePath: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

export const DRAFT_VERSION_PATTERN = /^\d+\.\d+\.\d+-draft\.[1-9]\d*$/
const PLAIN_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

// Used as the review-cycle base when the registry holds no plain version yet,
// so the first approval publishes 0.1.0 as it always has.
export const FIRST_BASE_VERSION = '0.1.0'

type Triple = [number, number, number]

const parseTriple = (plain: string): Triple | undefined => {
  const parts = plain.split('.').map(Number)
  // Digits beyond the safe-integer range would compare and print wrongly.
  if (parts.length !== 3 || !parts.every(Number.isSafeInteger)) return undefined
  return parts as Triple
}

const compareTriples = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/**
 * Allocate the next draft version from the registry's version list alone.
 * The base is the highest plain x.y.z with the patch bumped (plain drafts from
 * before prerelease versioning count as plain versions here); the draft number
 * continues from the highest existing draft of that same base. Anything that is
 * neither a plain version nor a well-formed draft is ignored.
 */
export const draftBaseVersion = (draftVersion: string): string => {
  if (!DRAFT_VERSION_PATTERN.test(draftVersion)) {
    throw new Error(`${draftVersion} is not a draft version (expected <x.y.z>-draft.<n>)`)
  }
  return draftVersion.slice(0, draftVersion.indexOf('-draft.'))
}

export const nextDraftVersion = (existingVersions: string[]): string => {
  let highestPlain: Triple | undefined
  for (const v of existingVersions) {
    if (!PLAIN_VERSION_PATTERN.test(v)) continue
    const triple = parseTriple(v)
    if (triple && (!highestPlain || compareTriples(triple, highestPlain) > 0)) highestPlain = triple
  }

  const base = highestPlain
    ? `${highestPlain[0]}.${highestPlain[1]}.${highestPlain[2] + 1}`
    : FIRST_BASE_VERSION

  let highestDraft = 0
  for (const v of existingVersions) {
    if (!DRAFT_VERSION_PATTERN.test(v)) continue
    const [draftBase, n] = v.split('-draft.')
    if (draftBase !== base) continue
    const draftNumber = Number(n)
    if (Number.isSafeInteger(draftNumber) && draftNumber > highestDraft) highestDraft = draftNumber
  }

  return `${base}-draft.${highestDraft + 1}`
}

export type VersionQuery = (command: string, args: string[]) => CaptureAllResult | Promise<CaptureAllResult>

const defaultQuery: VersionQuery = (command, args) => captureAll(command, args, {env: npmEnv()})

/** Every version the merchant's registry holds for the package; empty when it was never published. */
export const resolveExistingVersions = async (
  packageName: string,
  registryUrl: string,
  query: VersionQuery = defaultQuery,
): Promise<string[]> => {
  // Submissions carry only the `draft` dist-tag — a bare spec resolves via
  // `latest`, which never exists here, and npm view then prints nothing with
  // exit 0. Querying @draft resolves; the versions field is packument-wide, so
  // it also lists approved official versions. Scoped-registry config beats a
  // plain --registry, so the registry goes in as the scope-specific flag.
  const result = await query('npm', [
    'view', `${packageName}@draft`, 'versions', '--json',
    `--${SUBMISSIONS_SCOPE}:registry=${registryUrl}`, '--loglevel', NPM_LOGLEVEL,
  ])
  if (result.status === 0) {
    // A never-published package takes the E404 path below, so silence here
    // means the package exists without a `draft` tag — guessing an empty
    // registry would restart allocation at 0.1.0.
    if (result.stdout === '') {
      throw new Error(
        `${packageName} exists but has no draft dist-tag, so its versions cannot be listed — ask Reactiv to restore the draft tag before submitting`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      throw new Error(
        `unexpected registry response for ${packageName} — expected a JSON version list, got:\n${result.stdout.slice(0, 200)}`,
      )
    }
    if (typeof parsed === 'string') return [parsed]
    if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) return parsed
    throw new Error(`unexpected registry response for ${packageName} — expected a version string or list of version strings`)
  }
  // npm exits non-zero for a never-published package (E404) — that is the
  // first-submission case, not a failure.
  if (/E404|not found/i.test(result.stderr + result.stdout)) {
    return []
  }
  throw new Error(
    `could not query existing versions for ${packageName} — check your Reactiv login (\`reactiv whoami\`):\n${result.stderr}`,
  )
}
