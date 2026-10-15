import * as fs from 'node:fs'
import * as path from 'node:path'

/** Placeholder values stamped into the expanded template. */
export interface ScaffoldIdentity {
  appName: string
  appSlug: string
  appUuid: string
  bundleIdentifier: string
  platformVersion: string
  reactVersion: string
  reactNativeVersion: string
}

// A slug is one path component and one package name: lowercase letters,
// digits and dashes, nothing that could leave a directory.
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const isSlug = (value: string): boolean => SLUG.test(value)

export const toSlug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export const defaultBundleIdentifier = (slug: string): string =>
  `com.reactiv.${slug.replace(/-/g, '')}`

// Function-form replacements: a literal value containing `$&`/`$$` must never
// be interpreted as a replacement pattern.
export const fillPlaceholders = (text: string, identity: ScaffoldIdentity): string =>
  text
    .replaceAll('{{APP_NAME}}', () => identity.appName)
    .replaceAll('{{APP_SLUG}}', () => identity.appSlug)
    .replaceAll('{{APP_UUID}}', () => identity.appUuid)
    .replaceAll('{{BUNDLE_ID}}', () => identity.bundleIdentifier)
    .replaceAll('{{PLATFORM_VERSION}}', () => identity.platformVersion)
    .replaceAll('{{REACT_VERSION}}', () => identity.reactVersion)
    .replaceAll('{{REACT_NATIVE_VERSION}}', () => identity.reactNativeVersion)

/** Files the template ships under neutral names (npm strips/rewrites the real ones). */
export const expandedName = (name: string): string => RENAMES[name] ?? name

const RENAMES: Record<string, string> = {
  'package.json.template': 'package.json',
  gitignore: '.gitignore',
  npmrc: '.npmrc',
  'env.template': '.env',
}

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.json', '.template', '.md', '.h', '.m', '.mm', '.swift',
  '.storyboard', '.xcprivacy', '.plist', '.pbxproj', '.xcscheme', '.xml', '.gradle', '.kt',
  '.properties', '.podspec', '.rb', '.lock', '.yaml', '.yml',
])

const isTextFile = (file: string): boolean => {
  const base = path.basename(file)
  if (base === 'Podfile' || base === 'Gemfile' || base === 'gitignore' || base === 'npmrc' || base === '.watchmanconfig') return true
  return TEXT_EXTENSIONS.has(path.extname(file))
}

/**
 * Expand the extracted template payload into the target project directory,
 * applying renames and stamping placeholders in every text file.
 */
export const expandTemplate = (templateDir: string, targetDir: string, identity: ScaffoldIdentity): number => {
  let count = 0
  const walk = (from: string, to: string): void => {
    fs.mkdirSync(to, {recursive: true})
    for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
      const source = path.join(from, entry.name)
      const destinationName = RENAMES[entry.name] ?? entry.name
      const destination = path.join(to, destinationName)
      if (entry.isDirectory()) {
        walk(source, destination)
      } else if (isTextFile(source)) {
        fs.writeFileSync(destination, fillPlaceholders(fs.readFileSync(source, 'utf8'), identity))
        count += 1
      } else {
        fs.copyFileSync(source, destination)
        count += 1
      }
    }
  }
  walk(templateDir, targetDir)
  return count
}
