import * as fs from 'node:fs'
import {createRequire} from 'node:module'
import * as path from 'node:path'

import {toSlug} from './scaffold'

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
  const slug = toSlug(appName)
  if (!slug) {
    throw new Error(`appName in ${PROJECT_CONFIG} produced an empty package slug — use a name with letters or digits`)
  }
  return {appUuid, appName, slug}
}
