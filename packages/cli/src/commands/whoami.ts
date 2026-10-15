import {Command} from '@oclif/core'

import {createAuthContext, reportAuthError} from '../lib/auth/context'
import {sanitizeForOutput} from '../lib/auth/errors'
import {termsNotAcceptedForWhoami} from '../lib/auth/messages'
import {currentMe, ensureRegistryAuth, readTokenCache, resolveIdentity} from '../lib/auth/token'
import {findProjectRoot} from '../lib/project'

export class Whoami extends Command {
  static override description = 'Show the merchant, key and token state this machine is logged in as (never prints the key)'

  async run(): Promise<void> {
    await this.parse(Whoami)
    try {
      const ctx = createAuthContext(this, {nonInteractive: true})
      const identity = await resolveIdentity(ctx, {allowPendingTerms: true})
      const me = await currentMe(ctx, identity)
      const cache = readTokenCache(ctx)
      const cacheExpiry =
        cache && cache.keyId === identity.keyId && Date.parse(cache.expiresAt) > ctx.now() ? cache.expiresAt : undefined

      this.log(`Merchant:      ${sanitizeForOutput(me.merchant.slug)} (${sanitizeForOutput(me.merchant.appUuid)})`)
      this.log(`Key:           ${sanitizeForOutput(me.label)}`)
      this.log(`Holder:        ${sanitizeForOutput(me.holder)}`)
      this.log(`Key expires:   ${sanitizeForOutput(me.expiresAt)}`)
      this.log(`Status:        ${sanitizeForOutput(me.status)}`)
      this.log(`Token cache:   ${cacheExpiry ? `valid until ${cacheExpiry}` : 'none'}`)
      this.log(`Source:        ${identity.source === 'env' ? 'REACTIV_API_KEY' : 'stored login'}`)

      if (me.status !== 'active') {
        this.log(termsNotAcceptedForWhoami(sanitizeForOutput(me.terms.version)))
        return
      }
      const projectRoot = findProjectRoot(process.cwd())
      if (projectRoot) {
        const auth = await ensureRegistryAuth(ctx, projectRoot)
        if (auth.writtenFiles.length > 0) this.log(`Refreshed the registry token in ${auth.writtenFiles.join(', ')}.`)
      }
    } catch (error) {
      reportAuthError(this, error)
    }
  }
}
