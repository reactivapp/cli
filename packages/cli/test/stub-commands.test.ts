import {execFileSync} from 'node:child_process'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const binPath = join(__dirname, '..', 'bin', 'run')

const runCli = (args: string[], env: NodeJS.ProcessEnv = process.env): {stdout: string; stderr: string; failed: boolean} => {
  try {
    const stdout = execFileSync('node', [binPath, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env})
    return {stdout, stderr: '', failed: false}
  } catch (error) {
    const err = error as {stdout?: string; stderr?: string}
    return {stdout: err.stdout ?? '', stderr: err.stderr ?? '', failed: true}
  }
}

describe('topic commands', () => {
  it('app init without a login fails with an actionable message instead of prompting', () => {
    const home = mkdtempSync(join(tmpdir(), 'reactiv-stub-'))
    const env = {...process.env}
    delete env.REACTIV_API_KEY
    try {
      const result = runCli(['app', 'init'], {...env, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home})
      expect(result.failed).toBe(true)
      expect(result.stderr).toContain('reactiv login')
    } finally {
      rmSync(home, {recursive: true, force: true})
    }
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
