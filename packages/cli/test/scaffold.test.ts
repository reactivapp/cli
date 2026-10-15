import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {defaultBundleIdentifier, expandTemplate, fillPlaceholders, toSlug} from '../src/lib/scaffold'

const identity = {
  appName: 'Acme App',
  appSlug: 'acme-app',
  appUuid: '3f1c9a2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
  bundleIdentifier: 'com.reactiv.acmeapp',
  platformVersion: '2608.13.1',
  reactVersion: '19.2.3',
  reactNativeVersion: '0.86.0',
}

describe('toSlug', () => {
  it('kebab-cases names', () => {
    expect(toSlug('Acme App')).toBe('acme-app')
    expect(toSlug('  Weird__Name!! ')).toBe('weird-name')
  })
})

describe('defaultBundleIdentifier', () => {
  it('strips dashes', () => {
    expect(defaultBundleIdentifier('acme-app')).toBe('com.reactiv.acmeapp')
  })
})

describe('fillPlaceholders', () => {
  it('stamps every placeholder', () => {
    const out = fillPlaceholders(
      '{{APP_NAME}}|{{APP_SLUG}}|{{APP_UUID}}|{{BUNDLE_ID}}|{{PLATFORM_VERSION}}|{{REACT_VERSION}}|{{REACT_NATIVE_VERSION}}',
      identity,
    )
    expect(out).toBe(
      'Acme App|acme-app|3f1c9a2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b|com.reactiv.acmeapp|2608.13.1|19.2.3|0.86.0',
    )
  })
})

describe('expandTemplate', () => {
  it('renames neutral files and stamps placeholders', () => {
    const templateDir = mkdtempSync(join(tmpdir(), 'tpl-'))
    const targetDir = mkdtempSync(join(tmpdir(), 'out-'))
    writeFileSync(join(templateDir, 'package.json.template'), '{"name":"{{APP_SLUG}}","dependencies":{"@reactivapp/mobile":"{{PLATFORM_VERSION}}"}}')
    writeFileSync(join(templateDir, 'gitignore'), 'node_modules/')
    writeFileSync(join(templateDir, 'env.template'), 'REACTIV_APP_IDENTIFIER={{APP_UUID}}')
    mkdirSync(join(templateDir, 'custom'))
    writeFileSync(join(templateDir, 'custom', 'index.ts'), 'export {}')

    const count = expandTemplate(templateDir, targetDir, identity)

    expect(count).toBe(4)
    expect(existsSync(join(targetDir, '.gitignore'))).toBe(true)
    expect(JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')).dependencies['@reactivapp/mobile']).toBe('2608.13.1')
    expect(readFileSync(join(targetDir, '.env'), 'utf8')).toContain(identity.appUuid)
  })

  it('stamps the per-merchant submissions auth line from the app slug', () => {
    const templateDir = mkdtempSync(join(tmpdir(), 'tpl-'))
    const targetDir = mkdtempSync(join(tmpdir(), 'out-'))
    writeFileSync(
      join(templateDir, 'npmrc'),
      '//reactivapp-000000000000.d.codeartifact.us-east-1.amazonaws.com/npm/submissions-{{APP_SLUG}}/:_authToken=${CODEARTIFACT_AUTH_TOKEN}\n',
    )

    expandTemplate(templateDir, targetDir, identity)

    expect(readFileSync(join(targetDir, '.npmrc'), 'utf8')).toBe(
      '//reactivapp-000000000000.d.codeartifact.us-east-1.amazonaws.com/npm/submissions-acme-app/:_authToken=${CODEARTIFACT_AUTH_TOKEN}\n',
    )
  })
})
