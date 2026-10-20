import * as fs from 'node:fs'
import * as path from 'node:path'

import {APP_DIR, type Manifest} from './layout'
import {fillPlaceholders, type ScaffoldIdentity} from './scaffold'

export interface PlatformTrio {
  '@reactivapp/mobile': string
  react: string
  'react-native': string
}

export const DELEGATION_FILES = [
  `${APP_DIR}/metro.config.js`,
  `${APP_DIR}/babel.config.js`,
  `${APP_DIR}/react-native.config.js`,
  'tsconfig.json',
  `${APP_DIR}/ios/Podfile`,
]

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const isExactVersion = (version: string): boolean => EXACT_VERSION.test(version)

const compareIdentifiers = (left: string, right: string): number => {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

export const compareVersions = (left: string, right: string): number => {
  const [leftCore, leftPre] = splitVersion(left)
  const [rightCore, rightPre] = splitVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = compareIdentifiers(leftCore[index], rightCore[index])
    if (difference !== 0) return difference
  }
  if (leftPre === undefined || rightPre === undefined) return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1
  const leftParts = leftPre.split('.')
  const rightParts = rightPre.split('.')
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] === undefined) return -1
    if (rightParts[index] === undefined) return 1
    const difference = compareIdentifiers(leftParts[index], rightParts[index])
    if (difference !== 0) return difference
  }
  return 0
}

const splitVersion = (version: string): [string[], string | undefined] => {
  if (!isExactVersion(version)) throw new Error(`"${version}" is not an exact version`)
  const dash = version.indexOf('-')
  const core = dash === -1 ? version : version.slice(0, dash)
  return [core.split('.'), dash === -1 ? undefined : version.slice(dash + 1)]
}

const detectIndent = (text: string): string | number => /^([ \t]+)"/m.exec(text)?.[1] ?? (text.trim().includes('\n') ? 2 : 0)

export type ManifestSection = 'dependencies' | 'peerDependencies' | 'devDependencies'

export const setPlatformVersions = (text: string, section: ManifestSection, trio: PlatformTrio): string => {
  const manifest = JSON.parse(text) as Record<string, unknown>
  const current = manifest[section]
  const entries = typeof current === 'object' && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>) : {}
  manifest[section] = {...entries, ...trio}
  const rendered = JSON.stringify(manifest, null, detectIndent(text))
  const updated = text.endsWith('\n') ? `${rendered}\n` : rendered
  return JSON.stringify(JSON.parse(updated)) === JSON.stringify(JSON.parse(text)) ? text : updated
}

export interface DelegationStep {
  file: string
  kind: 'missing' | 'differs' | 'script' | 'unchecked'
  replacement: string
}

const readIfFile = (file: string): string | undefined => {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : undefined
  } catch {
    return undefined
  }
}

export const findDelegationSteps = (templateDir: string, projectRoot: string, identity: ScaffoldIdentity, library: Manifest): DelegationStep[] => {
  const steps: DelegationStep[] = []
  for (const file of DELEGATION_FILES) {
    const shipped = readIfFile(path.join(templateDir, file))
    if (shipped === undefined) continue
    const replacement = fillPlaceholders(shipped, identity)
    if (shipped.includes('{{BUNDLE_ID}}') || /\{\{[A-Z0-9_]+\}\}/.test(replacement)) {
      steps.push({file, kind: 'unchecked', replacement: ''})
      continue
    }
    const current = readIfFile(path.join(projectRoot, file))
    if (current === undefined) steps.push({file, kind: 'missing', replacement})
    else if (current !== replacement) steps.push({file, kind: 'differs', replacement})
  }
  const templateManifest = readIfFile(path.join(templateDir, 'package.json.template'))
  if (templateManifest !== undefined) {
    let shippedScript: Record<string, unknown> | undefined
    try {
      shippedScript = (JSON.parse(fillPlaceholders(templateManifest, identity)) as Manifest).scripts as Record<string, unknown> | undefined
    } catch {
      return steps
    }
    const ownScript = (library.scripts as Record<string, unknown> | undefined)?.typecheck
    if (typeof shippedScript?.typecheck === 'string' && ownScript !== shippedScript.typecheck) {
      steps.push({file: 'package.json', kind: 'script', replacement: shippedScript.typecheck})
    }
  }
  return steps
}

export const formatDelegationSteps = (steps: DelegationStep[]): string =>
  [
    `${steps.length === 1 ? 'This file differs' : 'These files differ'} from the current @reactivapp/app-template. The CLI never edits them; apply each change by hand:`,
    ...steps.map(({file, kind, replacement}) => {
      if (kind === 'script') return `\n${file}: set "scripts"."typecheck" to ${JSON.stringify(replacement)}`
      if (kind === 'unchecked') return `\n${file}: not compared — the current template's copy needs a value the CLI cannot fill (your app's bundle identifier or a placeholder this CLI version does not know); compare it with @reactivapp/app-template by hand`
      const action = kind === 'missing' ? `${file} is missing — create it with exactly this content:` : `${file}: replace its entire content with:`
      return `\n${action}\n----- ${file} -----\n${replacement.endsWith('\n') ? replacement : `${replacement}\n`}----- end ${file} -----`
    }),
  ].join('\n')
