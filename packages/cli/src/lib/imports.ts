import * as fs from 'node:fs'
import {builtinModules} from 'node:module'
import * as path from 'node:path'
import ts from 'typescript'

import {LIBRARY_SOURCE_DIR, type ProjectLayout, readLibraryDependencies, readPlatformSupplied} from './layout.js'

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']

export interface ModuleReference {
  specifier: string
  line: number
}

export interface UncheckableLoad {
  line: number
  form: string
}

export interface SourceImports {
  references: ModuleReference[]
  uncheckable: UncheckableLoad[]
}

const scriptKindFor = (fileName: string): ts.ScriptKind => {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.ts') || fileName.endsWith('.mts') || fileName.endsWith('.cts')) return ts.ScriptKind.TS
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  return ts.ScriptKind.JS
}

const literalText = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined

const isRequireIdentifier = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === 'require'

const isRequireResolve = (node: ts.Node): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) && isRequireIdentifier(node.expression) && node.name.text === 'resolve'

const isCalleeOf = (node: ts.Node): boolean => {
  const {parent} = node
  return parent !== undefined && ts.isCallExpression(parent) && parent.expression === node
}

const isDirectRequire = (node: ts.Identifier): boolean =>
  isCalleeOf(node) || (isRequireResolve(node.parent) && node.parent.expression === node && isCalleeOf(node.parent))

export const collectSourceImports = (source: string, fileName: string): SourceImports => {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName))
  const parseErrors = (sourceFile as unknown as {parseDiagnostics?: ts.Diagnostic[]}).parseDiagnostics
  if (!Array.isArray(parseErrors)) {
    throw new Error(`the installed TypeScript ${ts.version} does not report parse errors the way this CLI expects — reinstall the CLI`)
  }
  if (parseErrors.length > 0) {
    throw new Error(`${fileName} does not parse: ${ts.flattenDiagnosticMessageText(parseErrors[0].messageText, ' ')} — fix the syntax error before submitting`)
  }
  const references: ModuleReference[] = []
  const uncheckable: UncheckableLoad[] = []
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  const record = (node: ts.Node, specifierNode: ts.Node | undefined, form: string): void => {
    const specifier = literalText(specifierNode)
    if (specifier === undefined) uncheckable.push({line: lineOf(node), form})
    else references.push({specifier, line: lineOf(node)})
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      record(node, node.moduleSpecifier, ts.isImportDeclaration(node) ? 'import' : 'export … from')
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record(node, node.moduleReference.expression, 'import = require()')
    } else if (ts.isImportTypeNode(node)) {
      record(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, 'import type()')
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node, node.arguments[0], 'import()')
    } else if (ts.isCallExpression(node) && isRequireIdentifier(node.expression)) {
      record(node, node.arguments[0], 'require()')
    } else if (ts.isCallExpression(node) && isRequireResolve(node.expression)) {
      record(node, node.arguments[0], 'require.resolve()')
    } else if (ts.isIdentifier(node) && node.text === 'require' && !isDirectRequire(node)) {
      uncheckable.push({line: lineOf(node), form: 'require used other than as a direct call'})
    } else if (ts.isElementAccessExpression(node) && literalText(node.argumentExpression) === 'require') {
      uncheckable.push({line: lineOf(node), form: 'require reached through property access'})
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      uncheckable.push({line: lineOf(node), form: 'import.meta is not available in the app runtime'})
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return {references, uncheckable}
}

const isRelative = (specifier: string): boolean =>
  specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')

export const packageRoot = (specifier: string): string => {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const VALID_PACKAGE_ROOT = /^(?:@[^/@\s?#]+\/)?[^/@.\s?#][^/\s?#]*$/

const BUILTINS = new Set(builtinModules)

const platformAliasOf = (specifier: string, platformSupplied: ReadonlySet<string>): string | undefined => {
  for (const name of platformSupplied) {
    if (VALID_PACKAGE_ROOT.test(name)) continue
    if (specifier === name || specifier.startsWith(`${name}/`)) return name
  }
  return undefined
}

const isNodeBuiltin = (specifier: string): boolean => BUILTINS.has(specifier) || BUILTINS.has(packageRoot(specifier))

const listSourceFiles = (dir: string): string[] =>
  fs
    .readdirSync(dir, {withFileTypes: true})
    .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .flatMap(entry => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return listSourceFiles(full)
      return entry.isFile() && SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension)) ? [full] : []
    })

const installFix = (name: string): string => `run \`npm install --save-exact ${name}@<version>\` at the project root`

export interface ImportCrossCheck {
  errors: string[]
  warnings: string[]
}

export const crossCheckImports = (
  files: ReadonlyArray<{file: string; source: string}>,
  declared: Record<string, string>,
  platformSupplied: ReadonlySet<string>,
): ImportCrossCheck => {
  const unparsable: string[] = []
  const undeclared = new Map<string, string[]>()
  const builtins: string[] = []
  const outsideSource: string[] = []
  const platformInternals: string[] = []
  const notPackages: string[] = []
  const uncheckable: string[] = []
  const imported = new Set<string>()
  for (const {file, source} of files) {
    let scan: SourceImports
    try {
      scan = collectSourceImports(source, file)
    } catch (error) {
      unparsable.push(`  ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const {line, form} of scan.uncheckable) uncheckable.push(`  ${file}:${line} — ${form}`)
    for (const {specifier, line} of scan.references) {
      const where = `"${specifier}" in ${file}:${line}`
      if (isRelative(specifier)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
        if (target !== LIBRARY_SOURCE_DIR && !target.startsWith(`${LIBRARY_SOURCE_DIR}/`)) {
          outsideSource.push(`  ${where} — resolves to ${target}; move the file inside ${LIBRARY_SOURCE_DIR}/`)
        }
        continue
      }
      if (specifier.startsWith('node:')) {
        const bare = specifier.slice('node:'.length)
        builtins.push(
          Object.hasOwn(declared, packageRoot(bare))
            ? `  ${where} — import "${bare}" instead; the declared npm package of that name is what runs in the app`
            : `  ${where} — remove the import`,
        )
        continue
      }
      if (specifier.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) {
        notPackages.push(`  ${where} — import files inside ${LIBRARY_SOURCE_DIR}/ by relative path, or a declared package by name`)
        continue
      }
      if (specifier.startsWith('#')) {
        notPackages.push(`  ${where} — package.json "imports" aliases are not part of a submission; import the file by relative path`)
        continue
      }
      const alias = platformAliasOf(specifier, platformSupplied)
      if (alias !== undefined) {
        if (specifier === alias) {
          imported.add(alias)
          continue
        }
        platformInternals.push(`  ${where} — platform packages expose only their public entry; import from "${alias}"`)
        continue
      }
      const root = packageRoot(specifier)
      if (!VALID_PACKAGE_ROOT.test(root)) {
        notPackages.push(`  ${where} — not a valid package name`)
        continue
      }
      if (specifier.slice(root.length).split('/').some(segment => segment === '.' || segment === '..')) {
        notPackages.push(`  ${where} — "." and ".." segments would leave the package "${root}"; import the package or one of its own files`)
        continue
      }
      imported.add(root)
      if (Object.hasOwn(declared, root) || platformSupplied.has(specifier)) continue
      if (platformSupplied.has(root)) {
        platformInternals.push(`  ${where} — platform packages expose only their public entry; import from "${root}"`)
        continue
      }
      if (isNodeBuiltin(specifier)) {
        builtins.push(`  ${where} — remove the import, or if you meant the npm package "${root}", ${installFix(root)}`)
        continue
      }
      undeclared.set(root, [...(undeclared.get(root) ?? []), where])
    }
  }
  const errors: string[] = []
  if (unparsable.length > 0) errors.push(`${LIBRARY_SOURCE_DIR}/ files that do not parse, so their imports cannot be checked:`, ...unparsable)
  if (undeclared.size > 0) {
    errors.push(
      `${LIBRARY_SOURCE_DIR}/ imports packages that package.json does not declare:`,
      ...[...undeclared.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([root, places]) => `  ${root}: ${places.join(', ')} — ${installFix(root)}`),
    )
  }
  if (platformInternals.length > 0) errors.push(`${LIBRARY_SOURCE_DIR}/ imports internal paths of platform packages:`, ...platformInternals)
  if (builtins.length > 0) errors.push(`${LIBRARY_SOURCE_DIR}/ imports Node built-in modules, which do not exist in the app runtime (Hermes):`, ...builtins)
  if (notPackages.length > 0) errors.push(`${LIBRARY_SOURCE_DIR}/ imports paths that are not packages:`, ...notPackages)
  if (outsideSource.length > 0) errors.push(`${LIBRARY_SOURCE_DIR}/ imports files outside ${LIBRARY_SOURCE_DIR}/, which a submission does not pack:`, ...outsideSource)
  if (uncheckable.length > 0) {
    errors.push(`${LIBRARY_SOURCE_DIR}/ loads modules the dependency check cannot read — imports must be string literals and require may only be called directly:`, ...uncheckable)
  }
  const warnings = Object.keys(declared)
    .filter(name => !imported.has(name))
    .sort()
    .map(name => `package.json declares ${name} but nothing in ${LIBRARY_SOURCE_DIR}/ imports it — if nothing needs it, remove it from package.json (it ships with the submission)`)
  return {errors, warnings}
}

export interface DeclaredPackages {
  declared: Record<string, string>
  platformSupplied: ReadonlySet<string>
}

export const readDeclaredPackages = (layout: ProjectLayout): DeclaredPackages => ({
  declared: readLibraryDependencies(layout),
  platformSupplied: readPlatformSupplied(layout),
})

export const assertImportsDeclared = (root: string, {declared, platformSupplied}: DeclaredPackages): string[] => {
  const sourceDir = path.join(root, LIBRARY_SOURCE_DIR)
  const files = listSourceFiles(sourceDir)
    .sort()
    .map(full => ({file: path.relative(root, full).split(path.sep).join('/'), source: fs.readFileSync(full, 'utf8')}))
  const {errors, warnings} = crossCheckImports(files, declared, platformSupplied)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return warnings
}
