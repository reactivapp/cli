import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const binPath = join(__dirname, '..', 'bin', 'run')

const runCli = (args: string[]): {stdout: string; stderr: string; failed: boolean} => {
  try {
    const stdout = execFileSync('node', [binPath, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
    return {stdout, stderr: '', failed: false}
  } catch (error) {
    const err = error as {stdout?: string; stderr?: string}
    return {stdout: err.stdout ?? '', stderr: err.stderr ?? '', failed: true}
  }
}

describe('topic commands', () => {
  it('app init without flags and no TTY fails with an actionable message', () => {
    const result = runCli(['app', 'init'])
    expect(result.failed).toBe(true)
    expect(result.stderr).toContain('--name')
  })

  it('app run ios outside a project fails with an actionable message', () => {
    const result = runCli(['app', 'run', 'ios'])
    expect(result.failed).toBe(true)
    expect(result.stderr).toContain('reactiv.conf.js')
  })

  it('app upgrade outside a project fails mentioning reactiv.conf.js', () => {
    const result = runCli(['app', 'upgrade'])
    expect(result.failed).toBe(true)
    expect(result.stderr).toContain('reactiv.conf.js')
  })

  it('app submit outside a project fails mentioning reactiv.conf.js', () => {
    const result = runCli(['app', 'submit'])
    expect(result.failed).toBe(true)
    expect(result.stderr).toContain('reactiv.conf.js')
  })
})
