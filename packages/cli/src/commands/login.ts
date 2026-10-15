import {Command, Flags} from '@oclif/core'

import {assertSupportedPlatform, createAuthContext, reportAuthError} from '../lib/auth/context'
import {type ApiKey, parseApiKey, writeCredentials} from '../lib/auth/credentials'
import {AuthError, sanitizeForOutput} from '../lib/auth/errors'
import {withLock} from '../lib/auth/lock'
import {ENV_KEY_GUIDANCE} from '../lib/auth/messages'
import {lockPath} from '../lib/auth/paths'
import {readFirstStdinLine} from '../lib/auth/prompt'
import {
  acceptTerms,
  API_KEY_ENV,
  type AuthContext,
  clearTokenCache,
  ensureRegistryAuth,
  fetchMe,
  readTokenCache,
  resolveIdentity,
  warnIfKeyExpiring,
} from '../lib/auth/token'
import {findProjectRoot} from '../lib/project'

export class Login extends Command {
  static override description = 'Log in with the Reactiv API key issued to you; accepts the Reactiv Plus terms on first use'

  static override flags = {
    'with-token': Flags.boolean({description: 'read the API key from the first line of stdin', default: false}),
    'non-interactive': Flags.boolean({description: 'never prompt; fail if a prompt would be needed', default: false}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Login)
    try {
      assertSupportedPlatform(process.platform)
      const ctx = createAuthContext(this, {nonInteractive: flags['non-interactive']})
      if (ctx.env[API_KEY_ENV]) {
        await this.validateEnvKey(ctx)
        return
      }
      await this.loginWithKey(ctx, await this.readKey(ctx, flags['with-token']))
    } catch (error) {
      reportAuthError(this, error)
    }
  }

  private async readKey(ctx: AuthContext, withToken: boolean): Promise<ApiKey> {
    if (withToken) {
      if (process.stdin.isTTY) throw new AuthError('`--with-token` reads the key from a pipe: `reactiv login --with-token < key-file`. On a terminal, run `reactiv login` and paste it at the prompt.')
      return parseApiKey(await readFirstStdinLine())
    }
    if (!ctx.prompt.interactive) {
      throw new AuthError('No API key: run `reactiv login` on a terminal, or pipe the key in with `reactiv login --with-token`.')
    }
    return parseApiKey(await ctx.prompt.hidden('Paste your Reactiv API key (input is hidden): '))
  }

  private async validateEnvKey(ctx: AuthContext): Promise<void> {
    for (const line of ENV_KEY_GUIDANCE) this.log(line)
    const identity = await resolveIdentity(ctx)
    warnIfKeyExpiring(ctx, identity.keyExpiresAt)
    this.log(`${API_KEY_ENV} is valid for merchant ${sanitizeForOutput(identity.merchant.slug)}.`)
  }

  private async loginWithKey(ctx: AuthContext, apiKey: ApiKey): Promise<void> {
    const identity = {source: 'file' as const, apiKey, keyId: apiKey.keyId, merchant: {slug: '', appUuid: ''}}
    const me = await fetchMe(ctx, identity)

    if (me.status !== 'active') {
      await acceptTerms(ctx, identity, me)
    }

    // Lock only the write, never the prompt above: a human may take minutes.
    await withLock(lockPath(ctx.env), () => {
      writeCredentials(ctx.env, {
        version: 1,
        apiKey,
        keyId: apiKey.keyId,
        merchant: me.merchant,
        loggedInAt: new Date(ctx.now()).toISOString(),
        keyExpiresAt: me.expiresAt,
      })
      const cache = readTokenCache(ctx)
      if (cache && cache.keyId !== apiKey.keyId) clearTokenCache(ctx.env)
    }, ctx.lockOptions)

    this.log(`Logged in as ${sanitizeForOutput(me.merchant.slug)} (key ${sanitizeForOutput(me.label)}).`)
    warnIfKeyExpiring(ctx, me.expiresAt)

    const projectRoot = findProjectRoot(process.cwd())
    if (projectRoot) {
      const auth = await ensureRegistryAuth(ctx, projectRoot)
      this.log(
        auth.writtenFiles.length > 0
          ? `Refreshed the registry token in ${auth.writtenFiles.join(', ')}.`
          : 'Registry token in this project is already current.',
      )
    } else {
      this.log('Next: reactiv app init')
    }
  }
}
