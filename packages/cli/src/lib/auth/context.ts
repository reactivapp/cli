import type {Command} from '@oclif/core'

import {AuthError} from './errors'
import {UNSUPPORTED_PLATFORM} from './messages'
import {createTerminalPrompter} from './prompt'
import type {AuthContext} from './token'
import {createVendingClient, resolveVendingApiUrl} from './vending-client'

export const createAuthContext = (command: Command, options: {nonInteractive?: boolean} = {}): AuthContext => {
  const env = process.env
  const {url, overridden} = resolveVendingApiUrl(env)
  if (overridden) command.log(`using vending API ${url}`)
  return {
    env,
    vending: createVendingClient({baseUrl: url, cliVersion: command.config.version, onWait: message => command.warn(message)}),
    prompt: createTerminalPrompter(options.nonInteractive),
    log: message => command.log(message),
    warn: message => command.warn(message),
    now: Date.now,
  }
}

export const assertSupportedPlatform = (platform: NodeJS.Platform): void => {
  if (platform === 'win32') throw new AuthError(UNSUPPORTED_PLATFORM)
}

export const reportAuthError = (command: Command, error: unknown): never => {
  if (error instanceof AuthError) command.error(error.message)
  throw error
}
