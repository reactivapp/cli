import * as crypto from 'node:crypto'

import type {MeResponse} from './contract'
import type {ApiKey} from './credentials'
import {AuthError, sanitizeForOutput} from './errors'
import {acceptorMismatch, termsDocumentMismatch, termsMustBeInteractive} from './messages'
import type {Prompter} from './prompt'
import {REQUEST_TIMEOUT_MS, type VendingClient} from './vending-client'

export const AGREE_PHRASE = 'I agree'

export type FetchDocument = (url: string) => Promise<Buffer>

export const fetchTermsDocument: FetchDocument = async url => {
  const response = await fetch(url, {signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)})
  if (!response.ok || !response.url.startsWith('https:')) throw new Error(`terms fetch failed (${response.status})`)
  return Buffer.from(await response.arrayBuffer())
}

export interface TermsFlowOptions {
  me: MeResponse
  apiKey: ApiKey
  vending: VendingClient
  prompt: Prompter
  log: (message: string) => void
  fetchDocument?: FetchDocument
}

export const runTermsAcceptance = async (options: TermsFlowOptions): Promise<void> => {
  const {me, prompt, log} = options
  const version = sanitizeForOutput(me.terms.version)
  const url = sanitizeForOutput(me.terms.url)
  const holder = sanitizeForOutput(me.holder)

  if (!prompt.interactive) throw new AuthError(termsMustBeInteractive(version))

  let fingerprint: string
  try {
    if (!me.terms.url.startsWith('https://')) throw new Error('terms URL is not https')
    const document = await (options.fetchDocument ?? fetchTermsDocument)(me.terms.url)
    fingerprint = crypto.createHash('sha256').update(document).digest('hex')
  } catch {
    throw new AuthError(termsDocumentMismatch(url, version))
  }
  if (fingerprint !== me.terms.sha256.toLowerCase()) throw new AuthError(termsDocumentMismatch(url, version))

  log(`Reactiv Plus terms, version ${version}`)
  log(`  ${url}`)
  log(`  sha256 ${fingerprint} (verified)`)
  log('Open the URL and read the terms.')

  const answer = await prompt.line(`Type "${AGREE_PHRASE}" to accept the Reactiv Plus terms (version ${version}): `)
  if (answer !== AGREE_PHRASE) {
    throw new AuthError('Terms not accepted — nothing was sent to Reactiv.')
  }

  const confirmation = await prompt.line(`This key was issued to ${holder}. Is that you? (y/N): `)
  if (!/^y(es)?$/i.test(confirmation.trim())) {
    throw new AuthError(acceptorMismatch(holder))
  }

  await options.vending.acceptTerms(options.apiKey, {termsVersion: me.terms.version, acceptedBy: me.holder})
  log(`Accepted terms version ${version}.`)
}
