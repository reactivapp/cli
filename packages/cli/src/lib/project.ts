import * as fs from 'node:fs'
import {createRequire} from 'node:module'
import * as path from 'node:path'

import {isSlug, toSlug} from './scaffold'

export const PROJECT_CONFIG = 'reactiv.conf.js'

export const findProjectRoot = (start: string): string | undefined => {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, PROJECT_CONFIG))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export interface ProjectIdentity {
  appUuid: string
  appName: string
  slug: string
}

// The root package.json name is the merchant slug `app init` wrote; projects
// scaffolded before that carry it as the app name's slug.
const manifestSlug = (projectRoot: string): string | undefined => {
  let manifest: unknown
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const name = (manifest as {name?: unknown} | null)?.name
  return typeof name === 'string' && isSlug(name) ? name : undefined
}

// Same source `app submit` packs, so the binding check matches the artifact.
export const loadProjectIdentity = (projectRoot: string): ProjectIdentity => {
  const confPath = path.join(projectRoot, PROJECT_CONFIG)
  const require = createRequire(confPath)
  let conf: Record<string, unknown>
  try {
    delete require.cache[require.resolve(confPath)]
    conf = require(confPath) as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to load ${PROJECT_CONFIG} — fix the file and re-run: ${message}`)
  }
  const {appUuid, appName} = conf
  if (typeof appUuid !== 'string' || typeof appName !== 'string' || !appUuid || !appName) {
    throw new Error(`${PROJECT_CONFIG} must export appUuid and appName as non-empty strings`)
  }
  const slug = manifestSlug(projectRoot) ?? toSlug(appName)
  if (!slug) {
    throw new Error(`package.json has no usable name and appName in ${PROJECT_CONFIG} produced an empty slug — restore the name a fresh \`reactiv app init\` writes`)
  }
  return {appUuid, appName, slug}
}
