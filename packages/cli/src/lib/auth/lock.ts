import * as fs from 'node:fs'
import * as path from 'node:path'

import {AuthError} from './errors'
import {ensurePrivateDir, errorCode} from './files'

export interface LockOptions {
  staleMs?: number
  maxWaitMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  isProcessAlive?: (pid: number) => boolean
}

export const STALE_LOCK_MS = 60_000

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return errorCode(error) === 'EPERM'
  }
}

interface LockOwner {
  pid: number
  createdAtMs: number
}

const readOwner = (file: string): {owner?: LockOwner; raw?: string} => {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {}
    throw error
  }
  const [pidLine, timeLine] = raw.split('\n')
  const pid = Number(pidLine)
  let createdAtMs = Date.parse(timeLine ?? '')
  if (!Number.isFinite(createdAtMs)) {
    try {
      createdAtMs = fs.statSync(file).mtimeMs
    } catch {
      createdAtMs = 0
    }
  }
  return {owner: {pid: Number.isSafeInteger(pid) && pid > 0 ? pid : 0, createdAtMs}, raw}
}

// Advisory only: it serializes cooperating reactiv processes on one machine.
// A lock is taken over only when it is older than staleMs AND its owner is gone.
export const withLock = async <T>(file: string, critical: () => T | Promise<T>, options: LockOptions = {}): Promise<T> => {
  const staleMs = options.staleMs ?? STALE_LOCK_MS
  const maxWaitMs = options.maxWaitMs ?? staleMs + 10_000
  const pollMs = options.pollMs ?? 50
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const alive = options.isProcessAlive ?? isProcessAlive

  ensurePrivateDir(path.dirname(file))
  const startedAt = now()
  let content: string | undefined
  while (content === undefined) {
    const candidate = `${process.pid}\n${new Date(now()).toISOString()}\n`
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, candidate)
      } finally {
        fs.closeSync(fd)
      }
      content = candidate
      break
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }

    const {owner, raw} = readOwner(file)
    if (owner && now() - owner.createdAtMs > staleMs && !alive(owner.pid)) {
      // Re-check right before removing so a lock another process just took
      // over is not deleted from under it.
      if (readOwner(file).raw === raw) fs.rmSync(file, {force: true})
      continue
    }
    if (now() - startedAt >= maxWaitMs) {
      throw new AuthError(
        `another reactiv process is holding ${file} (pid ${owner?.pid ?? 'unknown'}); wait for it to finish and try again`,
      )
    }
    await sleep(pollMs)
  }

  try {
    return await critical()
  } finally {
    if (readOwner(file).raw === content) fs.rmSync(file, {force: true})
  }
}
