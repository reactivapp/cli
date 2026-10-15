import * as os from 'node:os'
import * as path from 'node:path'

// Relative XDG values are ignored, per the XDG base directory spec.
const xdgDir = (env: NodeJS.ProcessEnv, variable: string, fallback: string): string => {
  const value = env[variable]
  if (value && path.isAbsolute(value)) return value
  return path.join(env.HOME && path.isAbsolute(env.HOME) ? env.HOME : os.homedir(), fallback)
}

export const configDir = (env: NodeJS.ProcessEnv): string => path.join(xdgDir(env, 'XDG_CONFIG_HOME', '.config'), 'reactiv')

export const cacheDir = (env: NodeJS.ProcessEnv): string => path.join(xdgDir(env, 'XDG_CACHE_HOME', '.cache'), 'reactiv')

export const credentialsPath = (env: NodeJS.ProcessEnv): string => path.join(configDir(env), 'credentials.json')

export const tokenCachePath = (env: NodeJS.ProcessEnv): string => path.join(cacheDir(env), 'token-cache.json')

export const lockPath = (env: NodeJS.ProcessEnv): string => path.join(configDir(env), '.lock')
