import * as crypto from 'node:crypto'
import {describe, expect, it} from 'vitest'

import type {MeResponse} from '../../src/lib/auth/contract'
import {parseApiKey} from '../../src/lib/auth/credentials'
import type {Prompter} from '../../src/lib/auth/prompt'
import {runTermsAcceptance} from '../../src/lib/auth/terms'
import {VendingError, type VendingClient} from '../../src/lib/auth/vending-client'
import {API_KEY, assertNoSecrets, meResponse} from '../helpers/fixtures'

const DOCUMENT = Buffer.from('Reactiv Plus Private Beta terms\n')
const DOCUMENT_SHA = crypto.createHash('sha256').update(DOCUMENT).digest('hex')

const pendingMe = (): MeResponse =>
  meResponse({status: 'pending_terms', terms: {version: 'v2', url: 'https://terms.example.test/t.pdf', sha256: DOCUMENT_SHA, acceptedVersion: null}})

const setup = (answers: string[], options: {interactive?: boolean; acceptError?: VendingError; document?: Buffer} = {}) => {
  const events: string[] = []
  const accepted: unknown[] = []
  const prompt: Prompter = {
    interactive: options.interactive ?? true,
    line: async question => {
      events.push(`prompt:${question}`)
      return answers.shift() ?? ''
    },
    hidden: async () => '',
  }
  const vending = {
    acceptTerms: async (_key: unknown, request: unknown) => {
      events.push('accept')
      if (options.acceptError) throw options.acceptError
      accepted.push(request)
      return {status: 'active', termsVersion: 'v2', acceptedAt: 'now'}
    },
  } as unknown as VendingClient
  const logs: string[] = []
  const run = (me = pendingMe()) =>
    runTermsAcceptance({
      me,
      apiKey: parseApiKey(API_KEY),
      vending,
      prompt,
      log: message => logs.push(message),
      fetchDocument: async url => {
        events.push(`fetch:${url}`)
        return options.document ?? DOCUMENT
      },
    })
  return {run, events, accepted, logs}
}

describe('terms acceptance', () => {
  it('verifies the document before prompting, then records acceptance as the key holder', async () => {
    const {run, events, accepted, logs} = setup(['I agree', 'y'])
    await run()
    expect(events[0]).toBe('fetch:https://terms.example.test/t.pdf')
    expect(events[1]).toBe('prompt:Type "I agree" to accept the Reactiv Plus terms (version v2): ')
    expect(events[2]).toBe('prompt:This key was issued to jane.doe@example.test. Is that you? (y/N): ')
    expect(events[3]).toBe('accept')
    expect(accepted).toEqual([{termsVersion: 'v2', acceptedBy: 'jane.doe@example.test'}])
    expect(logs).toContain(`  sha256 ${DOCUMENT_SHA} (verified)`)
    expect(logs).toContain('Open the URL and read the terms.')
    assertNoSecrets(...logs, ...events)
  })

  it('aborts with nothing accepted when the document does not match its fingerprint', async () => {
    const {run, events} = setup(['I agree', 'y'], {document: Buffer.from('tampered')})
    await expect(run()).rejects.toThrow(
      'The terms document at https://terms.example.test/t.pdf does not match the version Reactiv published (v2); nothing was accepted — try again later or contact Reactiv.',
    )
    expect(events.filter(event => event.startsWith('prompt:') || event === 'accept')).toEqual([])
  })

  it('refuses a terms URL that is not https', async () => {
    const {run, events} = setup(['I agree', 'y'])
    const me = pendingMe()
    me.terms.url = 'http://terms.example.test/t.pdf'
    await expect(run(me)).rejects.toThrow('does not match the version Reactiv published')
    expect(events).toEqual([])
  })

  it.each(['i agree', 'I agree ', 'yes', ''])('requires the exact phrase; %j aborts without a network call', async answer => {
    const {run, events} = setup([answer, 'y'])
    await expect(run()).rejects.toThrow('Terms not accepted — nothing was sent to Reactiv.')
    expect(events).not.toContain('accept')
  })

  it('aborts when the developer is not the key holder', async () => {
    const {run, events} = setup(['I agree', 'n'])
    await expect(run()).rejects.toThrow('This key was issued to jane.doe@example.test; accept the terms as that person')
    expect(events).not.toContain('accept')
  })

  it('fails without a TTY, before fetching anything', async () => {
    const {run, events} = setup([], {interactive: false})
    await expect(run()).rejects.toThrow('Terms version v2 must be accepted interactively once: run `reactiv login` on a terminal.')
    expect(events).toEqual([])
  })

  it('hands service errors to the caller unchanged, so identity-aware cleanup can run', async () => {
    const acceptError = new VendingError({kind: 'api', path: '/v1/terms/accept', code: 'acceptor_mismatch', status: 403, details: {holder: 'owner@example.test'}})
    const {run} = setup(['I agree', 'yes'], {acceptError})
    await expect(run()).rejects.toMatchObject({code: 'acceptor_mismatch', details: {holder: 'owner@example.test'}})
  })
})
