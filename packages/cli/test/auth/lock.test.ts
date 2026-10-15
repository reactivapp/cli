import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {withLock} from '../../src/lib/auth/lock'

describe('advisory lock', () => {
  let dir: string
  let lock: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lock-'))
    lock = join(dir, 'reactiv', '.lock')
  })
  afterEach(() => rmSync(dir, {recursive: true, force: true}))

  const writeForeignLock = (pid: number, createdAt: Date): void => {
    writeFileSync(lock, `${pid}\n${createdAt.toISOString()}\n`, {mode: 0o600})
  }

  it('creates the lock with mode 0600 holding the PID and an ISO timestamp, and removes it afterwards', async () => {
    let seen = ''
    await withLock(lock, () => {
      seen = readFileSync(lock, 'utf8')
      expect(statSync(lock).mode & 0o777).toBe(0o600)
    })
    const [pid, time] = seen.split('\n')
    expect(Number(pid)).toBe(process.pid)
    expect(Number.isFinite(Date.parse(time))).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })

  it('releases the lock when the critical section throws', async () => {
    await expect(withLock(lock, () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(existsSync(lock)).toBe(false)
  })

  it('waits for a live owner and gives up with a clear message', async () => {
    await withLock(lock, () => undefined)
    writeForeignLock(424242, new Date())
    let clock = 0
    await expect(
      withLock(lock, () => 'never', {
        maxWaitMs: 1000,
        now: () => clock,
        sleep: async ms => {
          clock += ms
        },
        isProcessAlive: () => true,
      }),
    ).rejects.toThrow('another reactiv process is holding')
    expect(readFileSync(lock, 'utf8')).toContain('424242')
  })

  it('reclaims a lock only when it is both older than 60 s and its owner is gone', async () => {
    await withLock(lock, () => undefined)
    const now = Date.parse('2026-10-01T12:00:00Z')

    // Old but the owner is alive: not reclaimed.
    writeForeignLock(424242, new Date(now - 61_000))
    let clock = now
    const sleep = async (ms: number): Promise<void> => {
      clock += ms
    }
    await expect(withLock(lock, () => 'x', {maxWaitMs: 200, now: () => clock, sleep, isProcessAlive: () => true})).rejects.toThrow()

    // Owner gone but the lock is fresh: not reclaimed.
    writeForeignLock(424242, new Date(now - 1_000))
    clock = now
    await expect(withLock(lock, () => 'x', {maxWaitMs: 200, now: () => clock, sleep, isProcessAlive: () => false})).rejects.toThrow()

    // Old and the owner is gone: reclaimed.
    writeForeignLock(424242, new Date(now - 61_000))
    clock = now
    await expect(withLock(lock, () => 'ran', {now: () => clock, sleep, isProcessAlive: () => false})).resolves.toBe('ran')
    expect(existsSync(lock)).toBe(false)
  })

  it('serializes two cooperating critical sections', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => undefined
    const first = withLock(lock, () => new Promise<void>(resolve => {
      order.push('first:start')
      releaseFirst = () => {
        order.push('first:end')
        resolve()
      }
    }))
    await new Promise(resolve => setTimeout(resolve, 20))
    const second = withLock(lock, () => {
      order.push('second')
    }, {pollMs: 5})
    await new Promise(resolve => setTimeout(resolve, 30))
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })
})
