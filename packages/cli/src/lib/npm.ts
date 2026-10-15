import {execFileSync, spawn, spawnSync} from 'node:child_process'

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** Run a command, streaming output to the user's terminal; throw on failure. */
export const run = (command: string, args: string[], options: RunOptions = {}): void => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: options.cwd,
    env: options.env ?? process.env,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
  }
}

/** Run a command and capture stdout (stderr passes through). */
export const capture = (command: string, args: string[], options: RunOptions = {}): string =>
  execFileSync(command, args, {cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'inherit']})
    .toString()
    .trim()

export interface CaptureAllResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Run a command capturing both streams; never throws on non-zero exit. */
export const captureAll = (command: string, args: string[], options: RunOptions = {}): CaptureAllResult => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim()}
}


// npm prints request headers, tokens included, at --loglevel verbose and above.
// An explicit --loglevel on the command line beats any user config.
export const NPM_LOGLEVEL = 'notice'

const NPM_ENV_OVERRIDES = /^npm_config_(loglevel|userconfig)$/i

export const npmEnv = (extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (!NPM_ENV_OVERRIDES.test(key)) env[key] = value
  }
  return {...env, ...extra}
}

export const isRegistryAuthError = (output: string): boolean => /\bE401\b/.test(output)

export const runTee = (command: string, args: string[], options: RunOptions = {}): Promise<{status: number | null; stderr: string}> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: options.cwd, env: options.env ?? process.env, stdio: ['inherit', 'inherit', 'pipe']})
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
      stderr = (stderr + chunk.toString('utf8')).slice(-65_536)
    })
    child.on('error', reject)
    child.on('close', status => resolve({status, stderr}))
  })
