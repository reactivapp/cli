import {chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
  assertNoAppNativeIntegration,
  findNativeIntegration,
  KNOWN_NATIVE_INTEGRATION_LIBRARIES,
  podspecNativeHook,
} from '../src/lib/native-integration'

const PLAIN_PODSPEC = [
  'Pod::Spec.new do |s|',
  "  s.name = 'plain-native'",
  "  s.source_files = 'ios/**/*.{h,m,mm}'",
  "  s.dependency 'React-Core'",
  'end',
].join('\n')

describe('podspecNativeHook', () => {
  it('finds script_phases, script_phase and prepare_command', () => {
    expect(podspecNativeHook("  s.script_phases = [{:name => 'x', :script => 'y'}]")).toBe('sets script_phases')
    expect(podspecNativeHook("  s.script_phase = {:name => 'x', :script => 'y'}")).toBe('sets script_phase')
    expect(podspecNativeHook("  spec.prepare_command='sh setup.sh'")).toBe('sets prepare_command')
  })

  it('sees hooks set through send or split across lines', () => {
    expect(podspecNativeHook("  s.send(:prepare_command=, 'make')")).toBe('sets prepare_command')
    expect(podspecNativeHook("  s.public_send :script_phases=, []")).toBe('sets script_phases')
    expect(podspecNativeHook("  s.\n    script_phase = {:name => 'x'}")).toBe('sets script_phase')
    expect(podspecNativeHook("  s\n    .prepare_command = 'make'")).toBe('sets prepare_command')
    expect(podspecNativeHook("  s.script_phases \\\n    = []")).toBe('sets script_phases')
  })

  it('reads hook keys from a podspec.json, including subspecs, and fails closed on invalid JSON', () => {
    expect(podspecNativeHook('{"name": "x", "prepare_command": "sh setup.sh"}', 'x.podspec.json')).toBe('sets prepare_command')
    expect(podspecNativeHook('{"name": "x", "subspecs": [{"name": "y", "script_phases": [{"name": "gen"}]}]}', 'x.podspec.json')).toBe('sets script_phases')
    expect(podspecNativeHook('{"name": "x", "description": "no prepare_command or script_phases here"}', 'x.podspec.json')).toBeUndefined()
    expect(podspecNativeHook('{"name": ', 'x.podspec.json')).toBe('is not valid JSON, so its build hooks cannot be checked')
  })

  it('ignores plain podspecs, commented-out hooks and hook names inside strings', () => {
    expect(podspecNativeHook(PLAIN_PODSPEC)).toBeUndefined()
    expect(podspecNativeHook("  # s.script_phase = {:name => 'x'}")).toBeUndefined()
    expect(podspecNativeHook("  s.description = 'Needs no prepare_command and no script_phases'")).toBeUndefined()
    expect(podspecNativeHook("  s.summary = 'unlike lib.prepare_command = setup, this needs nothing'")).toBeUndefined()
    expect(podspecNativeHook("  s.description = <<-DESC\n    Replaces spec.script_phases = [] tricks\n  DESC")).toBeUndefined()
  })
})

describe('findNativeIntegration', () => {
  let root: string
  let appDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'native-integration-'))
    appDir = join(root, 'app')
  })

  afterEach(() => rmSync(root, {recursive: true, force: true}))

  const install = (name: string, files: Record<string, string>): void => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(appDir, 'node_modules', name, file, '..'), {recursive: true})
      writeFileSync(join(appDir, 'node_modules', name, file), content)
    }
  }

  it('rejects a dependency whose podspec carries script_phases, naming the file', () => {
    install('scripted-native', {'package.json': '{}', 'scripted-native.podspec': "Pod::Spec.new do |s|\n  s.script_phases = [{:name => 'gen'}]\nend\n"})
    expect(findNativeIntegration(appDir, {'scripted-native': '1.0.0'})).toEqual([
      '  scripted-native: app/node_modules/scripted-native/scripted-native.podspec sets script_phases',
    ])
  })

  it('finds a podspec below the package root and a scoped package', () => {
    install('@acme/prepared', {'package.json': '{}', 'ios/Prepared.podspec': "s.prepare_command = 'make'\n"})
    expect(findNativeIntegration(appDir, {'@acme/prepared': '2.0.0'})).toEqual([
      '  @acme/prepared: app/node_modules/@acme/prepared/ios/Prepared.podspec sets prepare_command',
    ])
  })

  it('reads a podspec.json found on disk', () => {
    install('json-scripted', {'package.json': '{}', 'json-scripted.podspec.json': '{"name": "json-scripted", "prepare_command": "sh setup.sh"}'})
    expect(findNativeIntegration(appDir, {'json-scripted': '1.0.0'})).toEqual([
      '  json-scripted: app/node_modules/json-scripted/json-scripted.podspec.json sets prepare_command',
    ])
  })

  it('reads podspecs whatever the extension case, and podspecs that are symlinks to files', () => {
    install('upper-native', {'package.json': '{}', 'ios/Upper.PODSPEC': "s.prepare_command = 'make'\n"})
    install('linked-native', {'package.json': '{}', 'real/linked.rb': "s.script_phase = {:name => 'x'}\n"})
    symlinkSync(join(appDir, 'node_modules', 'linked-native', 'real', 'linked.rb'), join(appDir, 'node_modules', 'linked-native', 'linked.podspec'))
    expect(findNativeIntegration(appDir, {'upper-native': '1.0.0', 'linked-native': '1.0.0'})).toEqual([
      '  linked-native: app/node_modules/linked-native/linked.podspec sets script_phase',
      '  upper-native: app/node_modules/upper-native/ios/Upper.PODSPEC sets prepare_command',
    ])
  })

  it('reports a podspec symlink whose target cannot be read, and skips a dangling one', () => {
    install('loop-native', {'package.json': '{}'})
    install('dangling-native', {'package.json': '{}'})
    const loopDir = join(appDir, 'node_modules', 'loop-native')
    symlinkSync(join(loopDir, 'b.podspec'), join(loopDir, 'a.podspec'))
    symlinkSync(join(loopDir, 'a.podspec'), join(loopDir, 'b.podspec'))
    symlinkSync(join(root, 'missing'), join(appDir, 'node_modules', 'dangling-native', 'gone.podspec'))
    expect(findNativeIntegration(appDir, {'loop-native': '1.0.0', 'dangling-native': '1.0.0'})).toEqual([
      '  loop-native: app/node_modules/loop-native/a.podspec could not be read, so its build hooks cannot be checked',
      '  loop-native: app/node_modules/loop-native/b.podspec could not be read, so its build hooks cannot be checked',
    ])
  })

  it.skipIf(process.getuid?.() === 0)('reports an unreadable podspec or package directory as a finding instead of crashing', () => {
    install('locked-file', {'package.json': '{}', 'locked.podspec': PLAIN_PODSPEC})
    install('locked-dir', {'package.json': '{}', 'ios/x.m': ''})
    chmodSync(join(appDir, 'node_modules', 'locked-file', 'locked.podspec'), 0o000)
    chmodSync(join(appDir, 'node_modules', 'locked-dir', 'ios'), 0o000)
    try {
      expect(findNativeIntegration(appDir, {'locked-file': '1.0.0', 'locked-dir': '1.0.0'})).toEqual([
        '  locked-dir: app/node_modules/locked-dir/ios could not be read, so its build hooks cannot be checked',
        '  locked-file: app/node_modules/locked-file/locked.podspec could not be read, so its build hooks cannot be checked',
      ])
    } finally {
      chmodSync(join(appDir, 'node_modules', 'locked-file', 'locked.podspec'), 0o644)
      chmodSync(join(appDir, 'node_modules', 'locked-dir', 'ios'), 0o755)
    }
  })

  it('accepts a plain podspec and a JS-only package', () => {
    install('plain-native', {'package.json': '{}', 'plain-native.podspec': PLAIN_PODSPEC})
    install('js-only', {'package.json': '{}', 'index.js': 'module.exports = {}\n'})
    expect(findNativeIntegration(appDir, {'plain-native': '1.0.0', 'js-only': '1.0.0'})).toEqual([])
  })

  it('does not descend into a nested node_modules', () => {
    install('wrapper', {'package.json': '{}', 'node_modules/inner/inner.podspec': "s.script_phase = {:name => 'x'}\n"})
    expect(findNativeIntegration(appDir, {wrapper: '1.0.0'})).toEqual([])
  })

  it('rejects every library on the known list without reading its files', () => {
    const declared = Object.fromEntries(KNOWN_NATIVE_INTEGRATION_LIBRARIES.map(name => [name, '1.0.0']))
    expect(findNativeIntegration(appDir, declared)).toEqual(
      [...KNOWN_NATIVE_INTEGRATION_LIBRARIES].sort().map(name => `  ${name}: needs app-level native setup (AppDelegate, Podfile or Info.plist changes)`),
    )
  })

  it('stops the submission with the contact line and the limits of the check', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({dependencies: {'react-native-code-push': '9.0.1', 'plain-native': '1.0.0'}}))
    install('plain-native', {'package.json': '{}', 'plain-native.podspec': PLAIN_PODSPEC})
    expect(() => assertNoAppNativeIntegration({root, appDir})).toThrow(
      [
        'package.json dependencies include libraries that require native project changes a customization cannot ship — contact Reactiv:',
        '  react-native-code-push: needs app-level native setup (AppDelegate, Podfile or Info.plist changes)',
        "This check reads CocoaPods podspecs in app/node_modules and a short list of known libraries; a library that needs Gradle changes, Info.plist usage descriptions or entitlements is not detected here and is rejected at Reactiv's review instead.",
      ].join('\n'),
    )
  })

  it.skipIf(process.getuid?.() === 0)('reports unreadable files under their own heading, not as native changes', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({dependencies: {'locked-file': '1.0.0'}}))
    install('locked-file', {'package.json': '{}', 'locked.podspec': PLAIN_PODSPEC})
    chmodSync(join(appDir, 'node_modules', 'locked-file', 'locked.podspec'), 0o000)
    try {
      expect(() => assertNoAppNativeIntegration({root, appDir})).toThrow(
        [
          'package.json dependencies include files in app/node_modules that could not be read — fix their permissions (or reinstall with `npm install` in app/) and try again:',
          '  locked-file: app/node_modules/locked-file/locked.podspec could not be read, so its build hooks cannot be checked',
        ].join('\n'),
      )
    } finally {
      chmodSync(join(appDir, 'node_modules', 'locked-file', 'locked.podspec'), 0o644)
    }
  })

  it('reports known-list and podspec findings together, sorted by package', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({dependencies: {'scripted-native': '1.0.0', 'react-native-code-push': '9.0.1'}}))
    install('scripted-native', {'package.json': '{}', 'scripted-native.podspec': "s.script_phases = [{:name => 'gen'}]\n"})
    let message = ''
    try {
      assertNoAppNativeIntegration({root, appDir})
    } catch (error) {
      message = (error as Error).message
    }
    expect(message.split('\n').slice(1, 3)).toEqual([
      '  react-native-code-push: needs app-level native setup (AppDelegate, Podfile or Info.plist changes)',
      '  scripted-native: app/node_modules/scripted-native/scripted-native.podspec sets script_phases',
    ])
    expect(message).toContain('is not detected here')
  })

  it('passes a project with no native hooks', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({dependencies: {'plain-native': '1.0.0'}}))
    install('plain-native', {'package.json': '{}', 'plain-native.podspec': PLAIN_PODSPEC})
    expect(() => assertNoAppNativeIntegration({root, appDir})).not.toThrow()
  })
})
