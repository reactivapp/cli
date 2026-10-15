import * as fs from 'node:fs'
import * as path from 'node:path'

import {APP_DIR, type ProjectLayout, readLibraryDependencies} from './layout.js'

export const KNOWN_NATIVE_INTEGRATION_LIBRARIES = [
  '@react-native-firebase/app',
  'react-native-bootsplash',
  'react-native-code-push',
  'react-native-permissions',
  'react-native-splash-screen',
]

const UNREADABLE = 'could not be read, so its build hooks cannot be checked'

const HOOK_NAMES = ['prepare_command', 'script_phases', 'script_phase']

const RUBY_HOOK = /^\s*[A-Za-z_]\w*\.(?:(?:public_)?send\s*\(?\s*:)?(prepare_command|script_phases?)\s*=/

const isPodspec = (name: string): boolean => {
  const lower = name.toLowerCase()
  return lower.endsWith('.podspec') || lower.endsWith('.podspec.json')
}

interface PodspecSearch {
  podspecs: string[]
  unreadable: string[]
}

const linkTarget = (full: string): 'file' | 'other' | 'unreadable' => {
  try {
    return fs.statSync(full).isFile() ? 'file' : 'other'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'other' : 'unreadable'
  }
}

const findPodspecs = (dir: string, search: PodspecSearch = {podspecs: [], unreadable: []}): PodspecSearch => {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true})
  } catch {
    search.unreadable.push(dir)
    return search
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) findPodspecs(full, search)
    } else if (isPodspec(entry.name) && entry.isFile()) {
      search.podspecs.push(full)
    } else if (isPodspec(entry.name) && entry.isSymbolicLink()) {
      const target = linkTarget(full)
      if (target === 'file') search.podspecs.push(full)
      if (target === 'unreadable') search.unreadable.push(full)
    }
  }
  return search
}

const jsonHook = (value: unknown): string | undefined => {
  if (Array.isArray(value)) return value.map(jsonHook).find(hook => hook !== undefined)
  if (typeof value !== 'object' || value === null) return undefined
  const own = Object.keys(value).find(key => HOOK_NAMES.includes(key))
  return own === undefined ? Object.values(value).map(jsonHook).find(hook => hook !== undefined) : `sets ${own}`
}

export const podspecNativeHook = (content: string, fileName = 'x.podspec'): string | undefined => {
  if (path.extname(fileName).toLowerCase() === '.json') {
    try {
      return jsonHook(JSON.parse(content))
    } catch {
      return 'is not valid JSON, so its build hooks cannot be checked'
    }
  }
  const joined = content.replace(/\\\r?\n/g, ' ').replace(/\.[ \t]*\r?\n\s*/g, '.').replace(/\r?\n\s*\./g, '.')
  for (const line of joined.split('\n')) {
    const match = RUBY_HOOK.exec(line)
    if (match) return `sets ${match[1]}`
  }
  return undefined
}

export const findNativeIntegration = (appDir: string, dependencies: Record<string, string>): string[] => {
  const shown = (file: string): string => path.relative(path.dirname(appDir), file).split(path.sep).join('/')
  const unreadable = (file: string): string => `${shown(file)} ${UNREADABLE}`
  return Object.keys(dependencies)
    .sort()
    .flatMap(name => {
      if (KNOWN_NATIVE_INTEGRATION_LIBRARIES.includes(name)) return [`  ${name}: needs app-level native setup (AppDelegate, Podfile or Info.plist changes)`]
      const packageDir = path.join(appDir, 'node_modules', name)
      if (!fs.existsSync(packageDir) || !fs.statSync(packageDir).isDirectory()) return []
      const {podspecs, unreadable: unreadableDirs} = findPodspecs(packageDir)
      return [
        ...unreadableDirs.map(dir => `  ${name}: ${unreadable(dir)}`),
        ...podspecs.flatMap(podspec => {
          let content: string
          try {
            content = fs.readFileSync(podspec, 'utf8')
          } catch {
            return [`  ${name}: ${unreadable(podspec)}`]
          }
          const hook = podspecNativeHook(content, podspec)
          return hook === undefined ? [] : [`  ${name}: ${shown(podspec)} ${hook}`]
        }),
      ]
    })
}

export const assertNoAppNativeIntegration = (layout: ProjectLayout): void => {
  const findings = findNativeIntegration(layout.appDir, readLibraryDependencies(layout))
  if (findings.length === 0) return
  const unreadable = findings.filter(finding => finding.endsWith(UNREADABLE))
  const native = findings.filter(finding => !finding.endsWith(UNREADABLE))
  throw new Error(
    [
      ...(native.length > 0 ? ['package.json dependencies include libraries that require native project changes a customization cannot ship — contact Reactiv:', ...native] : []),
      ...(unreadable.length > 0
        ? [`package.json dependencies include files in ${APP_DIR}/node_modules that could not be read — fix their permissions (or reinstall with \`npm install\` in ${APP_DIR}/) and try again:`, ...unreadable]
        : []),
      `This check reads CocoaPods podspecs in ${APP_DIR}/node_modules and a short list of known libraries; a library that needs Gradle changes, Info.plist usage descriptions or entitlements is not detected here and is rejected at Reactiv's review instead.`,
    ].join('\n'),
  )
}
