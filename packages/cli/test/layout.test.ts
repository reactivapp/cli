import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {
  assertDependenciesInSync,
  assertSubmittableDependencies,
  findDependencyDrift,
  findDevTrioDrift,
  formatDependencyDrift,
  formatDevTrioDrift,
  readPlatformSupplied,
  resolveLayout,
} from '../src/lib/layout'
import {assertLibraryManifest, buildSubmissionManifest} from '../src/lib/submission'

const platform = {'@reactivapp/mobile': '2608.13.1', react: '19.2.3', 'react-native': '0.86.0'}

describe('findDevTrioDrift', () => {
  it('reports nothing when devDependencies carry the trio at the peer versions', () => {
    expect(findDevTrioDrift({peerDependencies: platform, devDependencies: {...platform, typescript: '~5.8.3'}})).toEqual([])
  })

  it('reports nothing for a project scaffolded before the template carried the trio', () => {
    expect(findDevTrioDrift({peerDependencies: platform, devDependencies: {typescript: '~5.8.3'}})).toEqual([])
    expect(findDevTrioDrift({peerDependencies: platform})).toEqual([])
  })

  it('reports a platform package whose devDependencies version differs from the peer', () => {
    const drift = findDevTrioDrift({peerDependencies: platform, devDependencies: {...platform, '@reactivapp/mobile': '2607.1.1'}})
    expect(drift).toEqual([{name: '@reactivapp/mobile', peer: '2608.13.1', dev: '2607.1.1'}])
    expect(formatDevTrioDrift(drift)).toContain('set devDependencies.@reactivapp/mobile to "2608.13.1"')
  })
})

describe('findDependencyDrift', () => {
  it('reports nothing when the shell mirrors the library exactly', () => {
    expect(
      findDependencyDrift({dependencies: {'date-fns': '4.1.0'}}, {dependencies: {...platform, 'date-fns': '4.1.0'}}),
    ).toEqual([])
  })

  it('reports nothing for a library without dependencies', () => {
    expect(findDependencyDrift({}, {dependencies: platform})).toEqual([])
  })

  it('reports a library dependency the shell is missing', () => {
    expect(findDependencyDrift({dependencies: {'date-fns': '4.1.0'}}, {dependencies: platform})).toEqual([
      {name: 'date-fns', library: '4.1.0', app: undefined},
    ])
  })

  it('reports a spec mismatch, compared as written', () => {
    expect(
      findDependencyDrift({dependencies: {'date-fns': '^4.1.0'}}, {dependencies: {...platform, 'date-fns': '4.1.0'}}),
    ).toEqual([{name: 'date-fns', library: '^4.1.0', app: '4.1.0'}])
  })

  it('reports a shell-only dependency, which the merchant build would never install', () => {
    expect(findDependencyDrift({}, {dependencies: {...platform, 'react-native-maps': '1.20.0'}})).toEqual([
      {name: 'react-native-maps', app: '1.20.0'},
    ])
  })

  it('reports a shell dependency the library only declares as a peer', () => {
    expect(
      findDependencyDrift({peerDependencies: {'react-native-svg': '>=15'}}, {dependencies: {...platform, 'react-native-svg': '15.12.0'}}),
    ).toEqual([{name: 'react-native-svg', app: '15.12.0'}])
  })

  it('ignores inherited object keys', () => {
    expect(findDependencyDrift({dependencies: {}}, {dependencies: {...platform}})).toEqual([])
    expect(findDependencyDrift({dependencies: {constructor: '1.0.0'}}, {dependencies: platform})).toEqual([
      {name: 'constructor', library: '1.0.0', app: undefined},
    ])
  })

  it('never asks the library to mirror the platform packages the shell depends on', () => {
    expect(findDependencyDrift({dependencies: {}}, {dependencies: platform})).toEqual([])
  })
})

describe('formatDependencyDrift', () => {
  it('names the exact edit for each kind of drift and the install to run after', () => {
    const message = formatDependencyDrift([
      {name: 'a', library: '1.0.0'},
      {name: 'b', library: '2.0.0', app: '1.0.0'},
      {name: 'c', app: '3.0.0'},
    ])
    expect(message).toContain('a: missing from app/package.json — add "a": "1.0.0" to its dependencies')
    expect(message).toContain('b: "2.0.0" in package.json but "1.0.0" in app/package.json — set app/package.json to "2.0.0"')
    expect(message).toContain('c: in app/package.json only — add "c": "3.0.0" to the root package.json dependencies')
    expect(message).toContain('run `npm install` in app/')
  })
})

const platformManifest = {name: '@reactivapp/mobile', version: '2608.13.1', dependencies: {'@reactivapp/config': '1.0.0', 'react-native-svg': '15.12.0'}}

const installPlatform = (appDir: string): void => {
  for (const name of ['react', 'react-native'] as const) {
    mkdirSync(join(appDir, 'node_modules', name), {recursive: true})
    writeFileSync(join(appDir, 'node_modules', name, 'package.json'), JSON.stringify({name, version: platform[name]}))
  }
  writeFileSync(join(appDir, 'package-lock.json'), JSON.stringify({packages: {'node_modules/@reactivapp/mobile': {version: '2608.13.1'}}}))
}

const project = (library: object, app: object): string => {
  const root = mkdtempSync(join(tmpdir(), 'layout-'))
  mkdirSync(join(root, 'app', 'node_modules', '@reactivapp', 'mobile'), {recursive: true})
  writeFileSync(join(root, 'package.json'), JSON.stringify(library))
  writeFileSync(join(root, 'app', 'package.json'), JSON.stringify(app))
  writeFileSync(join(root, 'app', 'node_modules', '@reactivapp', 'mobile', 'package.json'), JSON.stringify(platformManifest))
  installPlatform(join(root, 'app'))
  return root
}

const install = (root: string, name: string, version = '1.0.0'): void => {
  mkdirSync(join(root, 'app', 'node_modules', name), {recursive: true})
  writeFileSync(join(root, 'app', 'node_modules', name, 'package.json'), JSON.stringify({name, version}))
}

const inSync = (deps: Record<string, string>, extra: object = {}): string => {
  const root = project({dependencies: deps, peerDependencies: platform, ...extra}, {dependencies: {...platform, ...deps}})
  for (const [name, version] of Object.entries(deps)) install(root, name, version)
  return root
}

describe('assertDependenciesInSync (app run and submit)', () => {
  it('passes an in-sync project', () => {
    expect(() => assertDependenciesInSync(resolveLayout(inSync({x: '1.0.0'})))).not.toThrow()
  })

  it('allows ranges and local specs while developing', () => {
    expect(() => assertDependenciesInSync(resolveLayout(inSync({a: '^2.1.0', b: 'file:../b'})))).not.toThrow()
  })

  it('throws the drift report', () => {
    const root = project({dependencies: {x: '1.0.0'}, peerDependencies: platform}, {dependencies: platform})
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('x: missing from app/package.json')
  })

  it('rejects a package the platform already ships declared as a library dependency', () => {
    for (const name of ['@reactivapp/config', 'react-native-svg']) {
      expect(() => assertDependenciesInSync(resolveLayout(inSync({[name]: '1.0.0'})))).toThrow('the platform already ships it')
    }
  })

  it('reports library peers that drift from the platform the shell runs', () => {
    const root = project({peerDependencies: {...platform, '@reactivapp/mobile': '2608.1.0'}}, {dependencies: platform})
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow(
      '@reactivapp/mobile: peer "2608.1.0" but app/package.json has "2608.13.1" — set package.json peerDependencies.@reactivapp/mobile to "2608.13.1"',
    )
  })

  it('tells the platform trio apart in the misplaced-dependency advice', () => {
    const root = project({dependencies: {react: '19.2.3'}, peerDependencies: platform}, {dependencies: platform})
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow(
      'react: remove it from package.json dependencies — it stays in peerDependencies and app/package.json',
    )
  })

  it('names the exact line when the shell lost a platform package', () => {
    const withoutReact = Object.fromEntries(Object.entries(platform).filter(([name]) => name !== 'react'))
    const root = project({peerDependencies: platform}, {dependencies: withoutReact})
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('react: missing from app/package.json — add "react": "19.2.3" to its dependencies')
  })

  it('requires mirrored dependencies to be installed in app/', () => {
    const root = project({dependencies: {x: '1.0.0'}, peerDependencies: platform}, {dependencies: {...platform, x: '1.0.0'}})
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('x is declared but not installed in app/')
  })

  it('requires react and react-native to be installed in app/', () => {
    const root = inSync({})
    rmSync(join(root, 'app', 'node_modules', 'react-native'), {recursive: true})
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('react-native is declared but not installed in app/')
  })

  it('tells the merchant to drop an app-only package the platform already ships', () => {
    const root = project({peerDependencies: platform}, {dependencies: {...platform, '@reactivapp/config': '1.0.0'}})
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('@reactivapp/config: the platform already ships it — remove it from app/package.json')
  })

  it('rejects a library dependency the platform keeps its own nested copy of', () => {
    const root = inSync({'lottie-react-native': '7.0.0'})
    mkdirSync(join(root, 'app', 'node_modules', '@reactivapp', 'mobile', 'node_modules', 'lottie-react-native'), {recursive: true})
    writeFileSync(join(root, 'app', 'node_modules', '@reactivapp', 'mobile', 'node_modules', 'lottie-react-native', 'package.json'), '{"version":"6.1.0"}')
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow(
      'lottie-react-native: the platform uses 6.1.0 — pin package.json and app/package.json to "6.1.0"',
    )
  })

  it('asks for a dedupe when the nested copy already matches the pin', () => {
    const root = inSync({'lottie-react-native': '7.0.0'})
    const nested = join(root, 'app', 'node_modules', '@reactivapp', 'mobile', 'node_modules', 'lottie-react-native')
    mkdirSync(nested, {recursive: true})
    writeFileSync(join(nested, 'package.json'), '{"version":"7.0.0"}')
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('lottie-react-native: both copies are 7.0.0 — run `npm dedupe` in app/')
  })

  it('treats an installed package without a version as a damaged install', () => {
    const root = inSync({'lottie-react-native': '7.0.0'})
    const nested = join(root, 'app', 'node_modules', '@reactivapp', 'mobile', 'node_modules', 'lottie-react-native')
    mkdirSync(nested, {recursive: true})
    writeFileSync(join(nested, 'package.json'), '{}')
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('has no version — the install is damaged')
  })

  const withPlatformPeer = (root: string): void => {
    const platformPath = join(root, 'app', 'node_modules', '@reactivapp', 'mobile', 'package.json')
    writeFileSync(platformPath, JSON.stringify({...platformManifest, peerDependencies: {'react-native-reanimated': '>=3'}}))
  }

  it('accepts a native platform peer in app/ that the library declares as a peer', () => {
    const root = project(
      {peerDependencies: {...platform, 'react-native-reanimated': '3.17.0'}},
      {dependencies: {...platform, 'react-native-reanimated': '3.17.0'}},
    )
    withPlatformPeer(root)
    expect(() => assertDependenciesInSync(resolveLayout(root))).not.toThrow()
  })

  it('requires a library-declared platform peer in app/package.json', () => {
    const root = project({peerDependencies: {...platform, 'react-native-reanimated': '3.17.0'}}, {dependencies: platform})
    withPlatformPeer(root)
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow(
      'react-native-reanimated: add "react-native-reanimated": "3.17.0" to app/package.json dependencies',
    )
  })

  it('suggests the installed exact version when the shell lists a range', () => {
    const root = project({peerDependencies: platform}, {dependencies: {...platform, 'react-native-reanimated': '^3.17.0'}})
    withPlatformPeer(root)
    install(root, 'react-native-reanimated', '3.17.2')
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('add its installed exact version ("3.17.2" now) to package.json peerDependencies')
  })

  it('asks for a peer declaration, not a dependency, for a platform peer only in app/', () => {
    const root = project({peerDependencies: platform}, {dependencies: {...platform, 'react-native-reanimated': '3.17.0'}})
    withPlatformPeer(root)
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow(
      'react-native-reanimated: the platform expects the app to provide it — run `npm install` in app/, keep it in app/package.json and add its installed exact version ("3.17.0" now) to package.json peerDependencies',
    )
  })

  it('still rejects a package the platform declares as a peer as a library dependency', () => {
    const root = project({dependencies: {'react-native-reanimated': '3.17.0'}, peerDependencies: platform}, {dependencies: {...platform, 'react-native-reanimated': '3.17.0'}})
    const platformPath = join(root, 'app', 'node_modules', '@reactivapp', 'mobile', 'package.json')
    writeFileSync(platformPath, JSON.stringify({...platformManifest, peerDependencies: {'react-native-reanimated': '>=3'}}))
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('react-native-reanimated: the platform expects the app to provide it — move it to peerDependencies and keep it in app/package.json')
  })

  it('requires the installed react and react-native to match app/package.json', () => {
    const root = inSync({})
    writeFileSync(join(root, 'app', 'node_modules', 'react', 'package.json'), JSON.stringify({name: 'react', version: '19.0.0'}))
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('does not hold the react@19.2.3 that app/package.json declares')
  })

  it('requires the platform to be installed in app/', () => {
    const root = inSync({})
    rmSync(join(root, 'app', 'node_modules', '@reactivapp'), {recursive: true})
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('@reactivapp/mobile is not installed in app/')
  })

  it('rejects non-string dependency values', () => {
    const root = project({dependencies: {x: 1}, peerDependencies: platform}, {dependencies: {...platform, x: 1}})
    expect(() => assertDependenciesInSync(resolveLayout(root))).toThrow('"x" must be a version string')
  })
})

describe('assertSubmittableDependencies (submit only)', () => {
  it('passes exact registry pins that are installed', () => {
    expect(() => assertSubmittableDependencies(resolveLayout(inSync({a: '1.0.0', b: '2.3.4-beta.1'})))).not.toThrow()
  })

  it('rejects dependencies that do not come from a registry', () => {
    for (const spec of ['file:../foo', 'link:../foo', 'github:acme/foo', 'acme/foo', 'git+https://example.test/foo.git', '../foo', 'npm:other@1.0.0']) {
      expect(() => assertSubmittableDependencies(resolveLayout(inSync({foo: spec})))).toThrow('must be registry versions')
    }
  })

  it('requires exact versions', () => {
    for (const spec of ['^1.0.0', '~1.0.0', '>=1', 'latest', '1.x']) {
      expect(() => assertSubmittableDependencies(resolveLayout(inSync({foo: spec})))).toThrow('must be exact versions')
    }
  })

  it('requires the installed version to match the pin', () => {
    const root = inSync({foo: '2.0.0'})
    install(root, 'foo', '1.9.0')
    expect(() => assertSubmittableDependencies(resolveLayout(root))).toThrow('does not hold the declared versions of foo@2.0.0')
  })

  it('requires the installed package to be the declared one, not a substitute', () => {
    const root = inSync({foo: '1.2.3'})
    writeFileSync(join(root, 'app', 'node_modules', 'foo', 'package.json'), JSON.stringify({name: 'other', version: '1.2.3'}))
    expect(() => assertSubmittableDependencies(resolveLayout(root))).toThrow('does not hold the declared versions of foo@1.2.3')
  })

  it('refuses app/package.json overrides', () => {
    const root = project({peerDependencies: platform}, {dependencies: platform, overrides: {foo: 'npm:other@1.2.3'}})
    expect(() => assertSubmittableDependencies(resolveLayout(root))).toThrow('"overrides" cannot be submitted')
  })

  it('requires platform-supplied peers to name the installed version', () => {
    const root = inSync({}, {peerDependencies: {...platform, 'react-native-svg': '^15.0.0'}})
    install(root, 'react-native-svg', '15.12.0')
    expect(() => assertSubmittableDependencies(resolveLayout(root))).toThrow('react-native-svg: "^15.0.0" — set it to "15.12.0", the version the platform uses')
  })

  it('refuses two different copies of a supplied peer', () => {
    const root = inSync({}, {peerDependencies: {...platform, 'react-native-svg': '15.12.0'}})
    install(root, 'react-native-svg', '15.0.0')
    const nested = join(root, 'app', 'node_modules', '@reactivapp', 'mobile', 'node_modules', 'react-native-svg')
    mkdirSync(nested, {recursive: true})
    writeFileSync(join(nested, 'package.json'), JSON.stringify({name: 'react-native-svg', version: '15.12.0'}))
    expect(() => assertSubmittableDependencies(resolveLayout(root))).toThrow(
      'react-native-svg: two copies in app/ (15.0.0 for src/, 15.12.0 for the platform) — run `npm ls react-native-svg` in app/',
    )
  })

  it('accepts a supplied peer that only the platform holds', () => {
    const root = inSync({}, {peerDependencies: {...platform, 'react-native-svg': '15.12.0'}})
    const nested = join(root, 'app', 'node_modules', '@reactivapp', 'mobile', 'node_modules', 'react-native-svg')
    mkdirSync(nested, {recursive: true})
    writeFileSync(join(nested, 'package.json'), JSON.stringify({name: 'react-native-svg', version: '15.12.0'}))
    expect(() => assertSubmittableDependencies(resolveLayout(root))).not.toThrow()
  })

  it('reports a supplied peer that is not installed at all', () => {
    const root = inSync({}, {peerDependencies: {...platform, 'react-native-svg': '15.12.0'}})
    expect(() => assertSubmittableDependencies(resolveLayout(root))).toThrow('react-native-svg: not installed in app/')
  })

  it('tells a pre-npm-7 lockfile from a stale one', () => {
    const root = inSync({})
    writeFileSync(join(root, 'app', 'package-lock.json'), JSON.stringify({lockfileVersion: 1, dependencies: {}}))
    expect(() => assertSubmittableDependencies(resolveLayout(root))).toThrow('predates npm 7')
    writeFileSync(join(root, 'app', 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages: {}}))
    expect(() => assertSubmittableDependencies(resolveLayout(root))).toThrow('records no installed @reactivapp/mobile')
  })

  it('explains a missing lockfile', () => {
    const root = inSync({})
    rmSync(join(root, 'app', 'package-lock.json'))
    expect(() => assertSubmittableDependencies(resolveLayout(root))).toThrow('app/package-lock.json not found — run `npm install` (npm 7 or later)')
  })

  it('refuses a platform install that disagrees with the lockfile', () => {
    const root = inSync({})
    writeFileSync(join(root, 'app', 'package-lock.json'), JSON.stringify({packages: {'node_modules/@reactivapp/mobile': {version: '2608.14.0'}}}))
    expect(() => assertSubmittableDependencies(resolveLayout(root))).toThrow('holds @reactivapp/mobile@2608.13.1 but app/package-lock.json records 2608.14.0')
  })

  it('requires exact platform peers at submit', () => {
    const root = project({peerDependencies: {...platform, react: '^19.2.3'}}, {dependencies: {...platform, react: '^19.2.3'}})
    expect(() => assertSubmittableDependencies(resolveLayout(root))).toThrow('peerDependencies react must be exact versions')
  })

  it('rejects reserved scopes', () => {
    expect(() => assertSubmittableDependencies(resolveLayout(inSync({'@reactiv-submissions/other': '0.1.0'})))).toThrow('never submission dependencies')
  })

  it('rejects peers the platform does not supply, and accepts ones it does', () => {
    expect(() => assertSubmittableDependencies(resolveLayout(inSync({}, {peerDependencies: {...platform, 'lottie-react-native': '7.0.0'}})))).toThrow(
      'lottie-react-native is not supplied by the platform',
    )
    const root = inSync({}, {peerDependencies: {...platform, 'react-native-svg': '15.12.0'}})
    install(root, 'react-native-svg', '15.12.0')
    expect(() => assertSubmittableDependencies(resolveLayout(root))).not.toThrow()
  })
})

describe('resolveLayout', () => {
  it('explains the old layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-'))
    mkdirSync(join(root, 'custom'))
    expect(() => resolveLayout(root)).toThrow('old layout')
  })

  it('asks for the project root when app/ is missing', () => {
    expect(() => resolveLayout(mkdtempSync(join(tmpdir(), 'empty-')))).toThrow('run this from the project root')
  })
})

describe('assertLibraryManifest', () => {
  const library = {files: ['src'], main: 'src/index.ts', 'react-native': 'src/index.ts'}

  it('returns the entry of the scaffold manifest', () => {
    expect(assertLibraryManifest(library)).toBe('src/index.ts')
  })

  it('accepts a single entry field and a ./ prefix', () => {
    expect(assertLibraryManifest({files: ['src'], 'react-native': './src/index.tsx'})).toBe('src/index.tsx')
  })

  it('requires files to be exactly ["src"]', () => {
    expect(() => assertLibraryManifest({...library, files: ['src', 'app']})).toThrow('exactly ["src"]')
    expect(() => assertLibraryManifest({...library, files: undefined})).toThrow('exactly ["src"]')
  })

  it('requires an entry', () => {
    expect(() => assertLibraryManifest({files: ['src']})).toThrow('declare the library entry')
  })

  it('requires the entry to be src/index, the file the platform contract and typecheck read', () => {
    for (const entry of ['index.ts', 'src/../x.ts', 'src/data.json', 'src/lib/entry.ts', 'src/main.ts']) {
      expect(() => assertLibraryManifest({...library, main: entry, 'react-native': entry})).toThrow('must be src/index.ts')
    }
  })

  it('rejects dependency fields a submission cannot carry', () => {
    expect(() => assertLibraryManifest({...library, optionalDependencies: {x: '1.0.0'}})).toThrow('optionalDependencies cannot be submitted')
    expect(() => assertLibraryManifest({...library, bundleDependencies: ['x']})).toThrow('bundleDependencies cannot be submitted')
  })

  it('rejects diverging main and react-native entries', () => {
    expect(() => assertLibraryManifest({...library, main: 'src/other.ts'})).toThrow('same file')
  })

  it('rejects a browser field, which Metro would prefer over main', () => {
    expect(() => assertLibraryManifest({...library, browser: 'src/web.ts'})).toThrow('"browser" is not supported')
  })

  it('rejects peerDependenciesMeta', () => {
    expect(() => assertLibraryManifest({...library, peerDependenciesMeta: {'react-native': {optional: true}}})).toThrow('peerDependenciesMeta cannot be submitted')
  })

  it('rejects the object form of the react-native field', () => {
    expect(() => assertLibraryManifest({...library, 'react-native': {'./a.js': './b.js'}})).toThrow('path string')
  })
})

describe('buildSubmissionManifest', () => {
  const stamp = {
    name: '@reactiv-submissions/acme',
    version: '0.1.0-draft.1',
    appName: 'Acme',
    reactivPlus: {appUuid: 'uuid', merchantSlug: 'acme', platformVersion: '2608.13.1'},
  }

  it('stamps identity, keeps dependency declarations, and drops local-only fields', () => {
    const manifest = buildSubmissionManifest(
      {
        name: 'acme',
        version: '0.0.1',
        private: true,
        main: 'src/index.ts',
        'react-native': 'src/index.ts',
        files: ['src'],
        scripts: {prepare: 'evil'},
        dependencies: {x: '1.0.0'},
        peerDependencies: platform,
        devDependencies: {typescript: '5'},
        publishConfig: {registry: 'https://registry.npmjs.org/'},
        bin: {acme: 'x'},
        peerDependenciesMeta: {react: {optional: true}},
        types: 'src/index.d.ts',
        reactivPlus: {appUuid: 'forged'},
      },
      stamp,
    )
    expect(manifest).toEqual({
      name: '@reactiv-submissions/acme',
      version: '0.1.0-draft.1',
      description: 'Reactiv Plus customization submission for Acme',
      main: 'src/index.ts',
      'react-native': 'src/index.ts',
      files: ['src'],
      dependencies: {x: '1.0.0'},
      license: 'UNLICENSED',
      reactivPlus: stamp.reactivPlus,
    })
  })

  it('keeps the developer description when there is one', () => {
    expect(buildSubmissionManifest({description: 'Acme widgets'}, stamp).description).toBe('Acme widgets')
  })
})

describe('readPlatformSupplied', () => {
  const platformDir = (root: string): string => join(root, 'app', 'node_modules', '@reactivapp', 'mobile')
  const withPlatform = (manifest: object, aliases?: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'supplied-'))
    mkdirSync(join(platformDir(root), 'toolchain'), {recursive: true})
    writeFileSync(join(platformDir(root), 'package.json'), JSON.stringify(manifest))
    if (aliases !== undefined) writeFileSync(join(platformDir(root), 'toolchain', 'aliases.json'), aliases)
    return root
  }
  const layoutOf = (root: string) => ({root, appDir: join(root, 'app')})
  const manifest = {name: '@reactivapp/mobile', dependencies: {'@reactivapp/config': '5.0.0'}, peerDependencies: {react: '19.0.0', 'react-native': '0.79.7'}}

  it('adds the alias names the platform toolchain ships beside its dependencies and peers', () => {
    const root = withPlatform(manifest, JSON.stringify({libAliases: {'@reactiv-mobile-core': 'reactiv-mobile-core', '@reactiv-mobile-ui-kit': 'reactiv-mobile-ui-kit'}, srcWildcardDirs: [], srcRootFiles: []}))
    const supplied = readPlatformSupplied(layoutOf(root))
    for (const name of ['@reactivapp/mobile', 'react', 'react-native', '@reactivapp/config', '@reactiv-mobile-core', '@reactiv-mobile-ui-kit']) expect(supplied.has(name)).toBe(true)
    rmSync(root, {recursive: true, force: true})
  })

  it('works without an aliases file and with an empty alias map', () => {
    for (const aliases of [undefined, JSON.stringify({libAliases: {}})]) {
      const root = withPlatform(manifest, aliases)
      expect([...readPlatformSupplied(layoutOf(root))].filter(name => name.startsWith('@reactiv-mobile'))).toEqual([])
      rmSync(root, {recursive: true, force: true})
    }
  })

  it('reports a toolchain entry that is not a directory instead of treating the aliases as absent', () => {
    const root = withPlatform(manifest)
    rmSync(join(platformDir(root), 'toolchain'), {recursive: true, force: true})
    writeFileSync(join(platformDir(root), 'toolchain'), 'not a directory')
    expect(() => readPlatformSupplied(layoutOf(root))).toThrow(/could not be read \(ENOTDIR\)/)
    rmSync(root, {recursive: true, force: true})
  })

  it('refuses a malformed aliases file', () => {
    const cases: Array<[string, RegExp]> = [
      ['{not json', /not valid JSON/],
      [JSON.stringify({libAliases: ['@reactiv-mobile-core']}), /"libAliases" object/],
      [JSON.stringify({libAliases: {'': 'x', 'react/native': 'y', __proto__: 'z'}}), /not scope-shaped/],
    ]
    for (const [aliases, message] of cases) {
      const root = withPlatform(manifest, aliases)
      expect(() => readPlatformSupplied(layoutOf(root))).toThrow(message)
      rmSync(root, {recursive: true, force: true})
    }
  })
})
