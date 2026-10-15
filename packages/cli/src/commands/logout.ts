import {Command} from '@oclif/core'
import * as path from 'node:path'

import {reportAuthError} from '../lib/auth/context'
import {clearCredentials} from '../lib/auth/credentials'
import {withLock} from '../lib/auth/lock'
import {installRoots, removeManagedBlock} from '../lib/auth/npmrc'
import {lockPath} from '../lib/auth/paths'
import {API_KEY_ENV, clearTokenCache} from '../lib/auth/token'
import {findProjectRoot} from '../lib/project'

export class Logout extends Command {
  static override description = "Delete the stored API key and token cache, and remove the registry token from this project's .npmrc"

  async run(): Promise<void> {
    await this.parse(Logout)
    const env = process.env
    try {
      const projectRoot = findProjectRoot(process.cwd())
      const cleaned = await withLock(lockPath(env), () => {
        // Credentials first: a concurrent refresh then sees them gone and writes nothing.
        clearCredentials(env)
        clearTokenCache(env)
        return projectRoot
          ? installRoots(projectRoot)
              .map(dir => path.join(dir, '.npmrc'))
              .filter(file => removeManagedBlock(file, message => this.warn(message)))
          : []
      })
      this.log('Logged out: stored API key and token cache deleted.')
      for (const file of cleaned) this.log(`Removed the registry token from ${file}.`)
      if (!projectRoot) {
        this.log("Other projects' .npmrc tokens are not touched; they expire within 12 hours.")
      }
      if (env[API_KEY_ENV]) this.warn(`${API_KEY_ENV} is still set in this shell and keeps authenticating reactiv commands.`)
    } catch (error) {
      reportAuthError(this, error)
    }
  }
}
