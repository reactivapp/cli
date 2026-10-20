import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {skippedInstallScripts} from '../src/lib/bootstrap-registry'
import type {ScaffoldIdentity} from '../src/lib/scaffold'
import {compareVersions, findDelegationSteps, formatDelegationSteps, setPlatformVersions} from '../src/lib/upgrade'

const TRIO = {'@reactivapp/mobile': '2610.9.3', react: '19.2.4', 'react-native': '0.87.1'}

describe('compareVersions', () => {
  it.each([
    ['2610.9.3', '2608.13.1', 1],
    ['2608.13.1', '2610.9.3', -1],
    ['2610.10.1', '2610.9.3', 1],
    ['2610.9.3', '2610.9.3', 0],
    ['2610.9.3-rc.1', '2610.9.3', -1],
    ['2610.9.3-rc.10', '2610.9.3-rc.2', 1],
    ['2610.9.3-rc', '2610.9.3-rc.1', -1],
  ])('%s vs %s → %i', (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected)
  })

  it('refuses a range', () => {
    expect(() => compareVersions('^2610.9.3', '2610.9.3')).toThrow('not an exact version')
  })
})

describe('setPlatformVersions', () => {
  const pretty = `${JSON.stringify(
    {name: 'shop', scripts: {typecheck: 'tsc'}, dependencies: {'date-fns': '4.1.0', '@reactivapp/mobile': '2608.13.1', react: '19.2.3', 'react-native': '0.86.0'}},
    null,
    2,
  )}\n`

  it('sets only the platform trio, keeping key order, indent and trailing newline', () => {
    const updated = setPlatformVersions(pretty, 'dependencies', TRIO)
    expect(JSON.parse(updated)).toEqual({
      name: 'shop',
      scripts: {typecheck: 'tsc'},
      dependencies: {'date-fns': '4.1.0', ...TRIO},
    })
    expect(updated).toBe(pretty.replace('2608.13.1', '2610.9.3').replace('19.2.3', '19.2.4').replace('0.86.0', '0.87.1'))
  })

  it('returns the input byte for byte when nothing changes', () => {
    const once = setPlatformVersions(pretty, 'dependencies', TRIO)
    expect(setPlatformVersions(once, 'dependencies', TRIO)).toBe(once)
    const tabbed = once.replace(/^ {2}/gm, '\t')
    expect(setPlatformVersions(tabbed, 'dependencies', TRIO)).toBe(tabbed)
  })

  it('keeps tab indentation and compact single-line manifests as they are', () => {
    expect(setPlatformVersions('{\n\t"peerDependencies": {}\n}', 'peerDependencies', TRIO)).toBe(`{\n\t"peerDependencies": {\n\t\t"@reactivapp/mobile": "2610.9.3",\n\t\t"react": "19.2.4",\n\t\t"react-native": "0.87.1"\n\t}\n}`)
    expect(setPlatformVersions('{"name":"shop"}\n', 'peerDependencies', TRIO)).toBe(`${JSON.stringify({name: 'shop', peerDependencies: TRIO})}\n`)
  })
})

describe('findDelegationSteps', () => {
  let root: string
  let templateDir: string
  let projectDir: string
  const identity: ScaffoldIdentity = {
    appName: 'Shop',
    appSlug: 'shop',
    appUuid: 'uuid-1',
    bundleIdentifier: 'com.reactiv.shop',
    platformVersion: TRIO['@reactivapp/mobile'],
    reactVersion: TRIO.react,
    reactNativeVersion: TRIO['react-native'],
  }
  const put = (dir: string, file: string, content: string): void => {
    mkdirSync(dirname(join(dir, file)), {recursive: true})
    writeFileSync(join(dir, file), content)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'delegations-'))
    templateDir = join(root, 'template')
    projectDir = join(root, 'project')
    put(templateDir, 'app/metro.config.js', 'metro v2\n')
    put(templateDir, 'app/babel.config.js', 'babel\n')
    put(templateDir, 'tsconfig.json', '{"name": "{{APP_SLUG}}"}\n')
    put(templateDir, 'app/index.js', 'template index\n')
    put(templateDir, 'package.json.template', JSON.stringify({scripts: {typecheck: 'node toolchain/typecheck.mjs'}}))
    put(projectDir, 'app/metro.config.js', 'metro v1\n')
    put(projectDir, 'app/babel.config.js', 'babel\n')
    put(projectDir, 'app/index.js', 'developer index\n')
  })

  afterEach(() => rmSync(root, {recursive: true, force: true}))

  it('lists differing and missing delegations with placeholders filled, and ignores files outside the delegation set', () => {
    const steps = findDelegationSteps(templateDir, projectDir, identity, {scripts: {typecheck: 'tsc --noEmit'}})
    expect(steps).toEqual([
      {file: 'app/metro.config.js', kind: 'differs', replacement: 'metro v2\n'},
      {file: 'tsconfig.json', kind: 'missing', replacement: '{"name": "shop"}\n'},
      {file: 'package.json', kind: 'script', replacement: 'node toolchain/typecheck.mjs'},
    ])
    expect(formatDelegationSteps(steps)).toBe(
      [
        'These files differ from the current @reactivapp/app-template. The CLI never edits them; apply each change by hand:',
        '',
        'app/metro.config.js: replace its entire content with:',
        '----- app/metro.config.js -----',
        'metro v2',
        '----- end app/metro.config.js -----',
        '',
        'tsconfig.json is missing — create it with exactly this content:',
        '----- tsconfig.json -----',
        '{"name": "shop"}',
        '----- end tsconfig.json -----',
        '',
        'package.json: set "scripts"."typecheck" to "node toolchain/typecheck.mjs"',
      ].join('\n'),
    )
  })

  it('skips the script step when the template manifest does not parse after stamping', () => {
    put(templateDir, 'package.json.template', '{"name": "{{APP_NAME}}", "scripts": {"typecheck": "x"}}')
    const steps = findDelegationSteps(templateDir, projectDir, {...identity, appName: 'Shop "One"'}, {})
    expect(steps.map(step => step.kind)).toEqual(['differs', 'missing'])
  })

  it('skips a delegation file whose template content needs the bundle identifier', () => {
    put(templateDir, 'app/ios/Podfile', "# {{APP_SLUG}} bundle {{BUNDLE_ID}}\n")
    const steps = findDelegationSteps(templateDir, projectDir, identity, {scripts: {typecheck: 'node toolchain/typecheck.mjs'}})
    expect(steps).toEqual([
      {file: 'app/metro.config.js', kind: 'differs', replacement: 'metro v2\n'},
      {file: 'tsconfig.json', kind: 'missing', replacement: '{"name": "shop"}\n'},
      {file: 'app/ios/Podfile', kind: 'unchecked', replacement: ''},
    ])
    put(templateDir, 'app/ios/Podfile', '# {{FUTURE_V2}}\n')
    expect(findDelegationSteps(templateDir, projectDir, identity, {}).find(step => step.file === 'app/ios/Podfile')?.kind).toBe('unchecked')
    expect(formatDelegationSteps(steps)).toContain(
      "app/ios/Podfile: not compared — the current template's copy needs a value the CLI cannot fill (your app's bundle identifier or a placeholder this CLI version does not know); compare it with @reactivapp/app-template by hand",
    )
  })

  it('reports nothing when the project matches the template', () => {
    put(projectDir, 'app/metro.config.js', 'metro v2\n')
    put(projectDir, 'tsconfig.json', '{"name": "shop"}\n')
    expect(findDelegationSteps(templateDir, projectDir, identity, {scripts: {typecheck: 'node toolchain/typecheck.mjs'}})).toEqual([])
  })
})

describe('skippedInstallScripts', () => {
  it('treats an unreadable package-lock.json as no lockfile', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'skipped-'))
    try {
      writeFileSync(join(appDir, 'package.json'), JSON.stringify({scripts: {postinstall: 'x'}}))
      writeFileSync(join(appDir, 'package-lock.json'), '{"packages": ')
      expect(skippedInstallScripts(appDir)).toEqual(['package.json postinstall'])
    } finally {
      rmSync(appDir, {recursive: true, force: true})
    }
  })
})
