import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import type {CaptureAllResult} from '../src/lib/npm'

import {
  assertPackContents,
  assertReExportTargetsPacked,
  assertTarballContents,
  checkSizeCap,
  DRAFT_VERSION_PATTERN,
  FIRST_BASE_VERSION,
  draftBaseVersion,
  findEntryInTarball,
  findForbiddenPaths,
  nextDraftVersion,
  readPlatformVersionFromLockfile,
  resolveExistingVersions,
  type VersionQuery,
  validateEntryPointSource,
} from '../src/lib/submission'

describe('submit validateEntryPointSource (parser-based)', () => {
  it('rejects commented-out exports', () => {
    const source = '// export {CustomCompositions, registerCustomComponents}\nexport const Unrelated = 1'
    expect(() => validateEntryPointSource(source)).toThrow('CustomCompositions')
    expect(() => validateEntryPointSource(source)).toThrow('registerCustomComponents')
  })

  it('rejects renamed-away exports (export {X as Y} exports Y, not X)', () => {
    const source = 'export {CustomCompositions as Foo, registerCustomComponents as bar}'
    expect(() => validateEntryPointSource(source)).toThrow('CustomCompositions')
    expect(() => validateEntryPointSource(source)).toThrow('registerCustomComponents')
  })

  it('passes for re-export shape (the scaffold pattern)', () => {
    const source = "export {CustomCompositions} from './x';\nexport {registerCustomComponents} from './y';"
    expect(() => validateEntryPointSource(source)).not.toThrow()
  })

  it('passes for direct const + function exports', () => {
    const source = 'export const CustomCompositions = {};\nexport function registerCustomComponents() {}'
    expect(() => validateEntryPointSource(source)).not.toThrow()
  })

  it('passes for class export', () => {
    const source = 'export class CustomCompositions {}\nexport function registerCustomComponents() {}'
    expect(() => validateEntryPointSource(source)).not.toThrow()
  })

  it('passes for let/var exports', () => {
    const source = 'export let CustomCompositions = {};\nexport var registerCustomComponents = () => {}'
    expect(() => validateEntryPointSource(source)).not.toThrow()
  })
})

describe('submit validate forbidden content', () => {
  it('detects nested node_modules with a pack-like structure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'custom-'))
    const nested = join(dir, 'node_modules')
    mkdirSync(nested)
    writeFileSync(join(nested, 'package.json'), '{}')
    const result = findForbiddenPaths(dir)
    expect(result).toContain('node_modules')
  })

  it('detects deeply nested forbidden directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'custom-'))
    mkdirSync(join(dir, 'sub', 'build'), {recursive: true})
    const result = findForbiddenPaths(dir)
    expect(result).toEqual(['sub/build'])
  })

  it('returns empty for clean directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'custom-'))
    mkdirSync(join(dir, 'components'), {recursive: true})
    expect(findForbiddenPaths(dir)).toEqual([])
  })

  it('detects case variants of forbidden directory names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'custom-'))
    mkdirSync(join(dir, 'sub', 'Build'), {recursive: true})
    expect(findForbiddenPaths(dir)).toEqual(['sub/Build'])
  })

  it('detects symlinks, which npm pack would silently drop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'custom-'))
    const target = mkdtempSync(join(tmpdir(), 'elsewhere-'))
    symlinkSync(target, join(dir, 'linked'))
    expect(findForbiddenPaths(dir)).toEqual(['linked (symlink)'])
  })

  it('rejects a root-symlinked src directory', () => {
    const realDir = mkdtempSync(join(tmpdir(), 'real-custom-'))
    mkdirSync(join(realDir, 'components'))
    writeFileSync(join(realDir, 'index.ts'), 'export const x = 1')
    const parent = mkdtempSync(join(tmpdir(), 'link-parent-'))
    const link = join(parent, 'src')
    symlinkSync(realDir, link)

    const result = findForbiddenPaths(link)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]).toContain('symlink')
    expect(result[0]).toContain('real directory')
  })
})

describe('submit pack assertPackContents', () => {
  it('rejects node_modules in pack output', () => {
    const files = ['package.json', 'src/index.ts', 'src/node_modules/bad/index.js']
    expect(() => assertPackContents(files)).toThrow('forbidden content')
  })

  it('rejects files outside src/', () => {
    const files = ['package.json', 'src/index.ts', 'lib/leaked.ts']
    expect(() => assertPackContents(files)).toThrow('forbidden content')
  })

  it('rejects dotfiles in pack output', () => {
    expect(() => assertPackContents(['package.json', 'src/index.ts', 'src/.env'])).toThrow('forbidden content')
  })

  it('accepts clean pack output', () => {
    const files = ['package.json', 'src/index.ts', 'src/components/Hero.tsx']
    expect(() => assertPackContents(files)).not.toThrow()
  })
})

describe('submit findEntryInTarball', () => {
  it('finds index.ts in tarball entries', () => {
    const entries = ['package/package.json', 'package/src/index.ts', 'package/src/components/Hero.tsx']
    expect(findEntryInTarball(entries, 'src/index.ts')).toBe('package/src/index.ts')
  })

  it('finds index.tsx variant', () => {
    const entries = ['package/package.json', 'package/src/index.tsx']
    expect(findEntryInTarball(entries, 'src/index.tsx')).toBe('package/src/index.tsx')
  })

  it('finds index.js variant', () => {
    const entries = ['package/package.json', 'package/src/index.js']
    expect(findEntryInTarball(entries, 'src/index.js')).toBe('package/src/index.js')
  })

  it('throws when no entry point in tarball', () => {
    const entries = ['package/package.json', 'package/src/components/Hero.tsx']
    expect(() => findEntryInTarball(entries, 'src/index.ts')).toThrow('entry point')
    expect(() => findEntryInTarball(entries, 'src/index.ts')).toThrow('packed tarball')
  })
})

describe('submit assertTarballContents', () => {
  it('strips package/ prefix and validates', () => {
    const entries = ['package/package.json', 'package/src/index.ts', 'package/src/components/Hero.tsx']
    expect(() => assertTarballContents(entries, 'src/index.ts')).not.toThrow()
  })

  it('rejects forbidden paths in tarball', () => {
    const entries = ['package/package.json', 'package/src/index.ts', 'package/src/node_modules/bad.js']
    expect(() => assertTarballContents(entries, 'src/index.ts')).toThrow('forbidden content')
  })

  it('rejects tarball missing entry point', () => {
    const entries = ['package/package.json', 'package/src/components/Hero.tsx']
    expect(() => assertTarballContents(entries, 'src/index.ts')).toThrow('entry point')
  })
})

describe('submit validate size cap', () => {
  it('throws when unpacked size exceeds cap', () => {
    const sixMb = 6 * 1024 * 1024
    expect(() => checkSizeCap(sixMb, 5)).toThrow('size cap')
    expect(() => checkSizeCap(sixMb, 5)).toThrow('6.0 MB')
  })

  it('passes when within cap', () => {
    expect(() => checkSizeCap(1024, 5)).not.toThrow()
  })
})

describe('submit nextDraftVersion', () => {
  it('starts the first review cycle at 0.1.0-draft.1 on an empty registry', () => {
    expect(nextDraftVersion([])).toBe('0.1.0-draft.1')
  })

  it('opens the next base after the highest official version', () => {
    expect(nextDraftVersion(['0.1.7'])).toBe('0.1.8-draft.1')
  })

  it('increments the draft number on resubmit for the same base', () => {
    expect(nextDraftVersion(['0.1.7', '0.1.8-draft.1'])).toBe('0.1.8-draft.2')
  })

  it('moves to the next base once the draft base is approved', () => {
    expect(nextDraftVersion(['0.1.7', '0.1.8-draft.1', '0.1.8-draft.2', '0.1.8'])).toBe('0.1.9-draft.1')
  })

  it('counts plain-version drafts from before prerelease versioning as officials', () => {
    const earlierCycle = ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7']
    expect(nextDraftVersion(earlierCycle)).toBe('0.1.8-draft.1')
    expect(nextDraftVersion([...earlierCycle, '0.1.8-draft.1'])).toBe('0.1.8-draft.2')
  })

  it('continues drafts of 0.1.0 when only drafts exist', () => {
    expect(nextDraftVersion(['0.1.0-draft.1', '0.1.0-draft.2'])).toBe('0.1.0-draft.3')
  })

  it('compares draft numbers numerically, not lexicographically', () => {
    expect(nextDraftVersion(['0.1.7', '0.1.8-draft.9', '0.1.8-draft.10'])).toBe('0.1.8-draft.11')
  })

  it('continues from the highest draft number when there are gaps', () => {
    expect(nextDraftVersion(['0.1.7', '0.1.8-draft.1', '0.1.8-draft.3'])).toBe('0.1.8-draft.4')
  })

  it('picks the numerically highest official, not lexicographic', () => {
    expect(nextDraftVersion(['0.9.0', '0.10.0'])).toBe('0.10.1-draft.1')
    expect(nextDraftVersion(['1.0.9', '0.99.99'])).toBe('1.0.10-draft.1')
  })

  it('ignores drafts of any base other than the next one', () => {
    expect(nextDraftVersion(['0.1.7', '0.1.7-draft.4', '0.2.0-draft.2'])).toBe('0.1.8-draft.1')
  })

  it('is independent of the order the registry lists versions in', () => {
    expect(nextDraftVersion(['0.1.8-draft.2', '0.1.7', '0.1.8-draft.1', '0.1.6'])).toBe('0.1.8-draft.3')
  })
})

describe('submit nextDraftVersion malformed input', () => {
  const malformed = [
    'abc', '', '0.1', ['1', '2', '3', '4'].join(String.fromCharCode(46)), 'v0.1.9', ' 0.1.9', '0.1.9 ',
    '0.1.8-draft.0', '0.1.8-draft.01', '0.1.8-draft.', '0.1.8-draft.x', '0.1.8-draft.1.1',
    '0.1.8-DRAFT.5', '0.1.8-beta.1', '0.2.0-beta.1', '0.1.8+build.1', '0.1.8-draft.2+build',
    '99999999999999999999.0.0', '0.01.9', '01.1.9',
  ]

  it('drops malformed entries instead of letting them move the base or the draft number', () => {
    expect(nextDraftVersion(['0.1.7', '0.1.8-draft.1', ...malformed])).toBe('0.1.8-draft.2')
  })

  it('falls back to 0.1.0-draft.1 when every entry is malformed', () => {
    expect(nextDraftVersion(malformed)).toBe('0.1.0-draft.1')
  })

  it('does not count other prerelease tags as officials', () => {
    expect(nextDraftVersion(['0.1.7', '0.3.0-rc.1'])).toBe('0.1.8-draft.1')
  })
})

describe('submit draft version contract', () => {
  it('matches the shared draft pattern for every allocation', () => {
    const registries = [[], ['0.1.7'], ['0.1.7', '0.1.8-draft.41'], ['10.20.30'], ['abc']]
    for (const versions of registries) {
      expect(nextDraftVersion(versions)).toMatch(DRAFT_VERSION_PATTERN)
    }
  })

  it('starts an empty registry at base 0.1.0', () => {
    expect(FIRST_BASE_VERSION).toBe('0.1.0')
  })

  it('pins the shared pattern verbatim', () => {
    expect(DRAFT_VERSION_PATTERN.source).toBe('^\\d+\\.\\d+\\.\\d+-draft\\.[1-9]\\d*$')
  })

  it('walks a full review cycle against a simulated registry', () => {
    const registry = ['0.1.7']
    const submit = (): string => {
      const version = nextDraftVersion(registry)
      registry.push(version)
      return version
    }
    expect(submit()).toBe('0.1.8-draft.1')
    expect(submit()).toBe('0.1.8-draft.2')
    registry.push(draftBaseVersion('0.1.8-draft.2'))
    expect(submit()).toBe('0.1.9-draft.1')
  })

  it('strips the draft suffix to the base approval publishes', () => {
    expect(draftBaseVersion('0.1.8-draft.12')).toBe('0.1.8')
  })

  it('refuses to derive a base from something that is not a draft version', () => {
    expect(() => draftBaseVersion('0.1.8')).toThrow('not a draft version')
    expect(() => draftBaseVersion('0.1.8-draft.0')).toThrow('not a draft version')
  })
})

describe('submit resolveExistingVersions', () => {
  const REGISTRY = 'https://registry.example/npm/submissions-demo/'
  const fakeQuery = (result: CaptureAllResult) => {
    const calls: string[][] = []
    const query: VersionQuery = (command, args) => {
      calls.push([command, ...args])
      return result
    }
    return {calls, query}
  }

  it('queries the draft dist-tag spec with the scope-specific registry flag, never the bare package name', async () => {
    const {calls, query} = fakeQuery({status: 0, stdout: '["0.1.7"]', stderr: ''})
    await resolveExistingVersions('@reactiv-submissions/demo', REGISTRY, query)
    expect(calls).toEqual([
      ['npm', 'view', '@reactiv-submissions/demo@draft', 'versions', '--json', `--@reactiv-submissions:registry=${REGISTRY}`, '--loglevel', 'notice'],
    ])
  })

  it('returns the packument-wide version list', async () => {
    const {query} = fakeQuery({status: 0, stdout: '["0.1.7","0.1.8-draft.1","0.1.8"]', stderr: ''})
    expect(await resolveExistingVersions('@reactiv-submissions/demo', REGISTRY, query)).toEqual(['0.1.7', '0.1.8-draft.1', '0.1.8'])
  })

  it('wraps the bare string npm prints for a single version', async () => {
    const {query} = fakeQuery({status: 0, stdout: '"0.1.8-draft.1"', stderr: ''})
    expect(await resolveExistingVersions('@reactiv-submissions/demo', REGISTRY, query)).toEqual(['0.1.8-draft.1'])
  })

  it('refuses to guess when the package exists but the draft tag resolves to nothing', async () => {
    const {query} = fakeQuery({status: 0, stdout: '', stderr: ''})
    await expect(resolveExistingVersions('@reactiv-submissions/demo', REGISTRY, query)).rejects.toThrow('no draft dist-tag')
  })

  it('treats a never-published package (E404) as an empty registry', async () => {
    const {query} = fakeQuery({status: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found'})
    expect(await resolveExistingVersions('@reactiv-submissions/demo', REGISTRY, query)).toEqual([])
  })

  it('fails clearly when the registry answers with something other than JSON', async () => {
    const {query} = fakeQuery({status: 0, stdout: '<html>sign in</html>', stderr: ''})
    await expect(resolveExistingVersions('@reactiv-submissions/demo', REGISTRY, query)).rejects.toThrow('unexpected registry response')
  })

  it('fails clearly when the JSON is not a version list', async () => {
    for (const stdout of ['null', '42', '{"0.1.7":"2026-01-01"}', '["0.1.7", 3]']) {
      const {query} = fakeQuery({status: 0, stdout, stderr: ''})
      await expect(resolveExistingVersions('@reactiv-submissions/demo', REGISTRY, query)).rejects.toThrow('unexpected registry response')
    }
  })

  it('fails with an auth hint on any other registry error', async () => {
    const {query} = fakeQuery({status: 1, stdout: '', stderr: 'npm error code E401'})
    await expect(resolveExistingVersions('@reactiv-submissions/demo', REGISTRY, query)).rejects.toThrow('check your Reactiv login')
  })
})

describe('tarball-truth integration', () => {
  it('rejects when .npmignore excludes the entry point from the tarball', () => {
    const staging = mkdtempSync(join(tmpdir(), 'tarball-npmignore-'))
    try {
      mkdirSync(join(staging, 'src'))
      writeFileSync(
        join(staging, 'src', 'index.ts'),
        "export {CustomCompositions} from './x';\nexport {registerCustomComponents} from './y';",
      )
      writeFileSync(join(staging, 'src', '.npmignore'), 'index.ts\n')
      writeFileSync(join(staging, 'package.json'), JSON.stringify({name: 'test-npmignore', version: '0.0.1', files: ['src']}))

      const packOutput = execFileSync('npm', ['pack', '--json'], {cwd: staging, encoding: 'utf8'}).trim()
      const parsed = JSON.parse(packOutput) as {filename: string}[] | {filename: string}
      const packResult = Array.isArray(parsed) ? parsed[0] : parsed
      const tarballPath = join(staging, packResult.filename)

      const tarList = execFileSync('tar', ['-tzf', tarballPath], {encoding: 'utf8'}).trim()
      const entries = tarList.split('\n').filter(Boolean)

      expect(() => assertTarballContents(entries, 'src/index.ts')).toThrow('entry point')
    } finally {
      rmSync(staging, {recursive: true, force: true})
    }
  })

  it('valid scaffold passes end-to-end through tarball validation', () => {
    const staging = mkdtempSync(join(tmpdir(), 'tarball-valid-'))
    try {
      mkdirSync(join(staging, 'src'))
      writeFileSync(
        join(staging, 'src', 'index.ts'),
        "export {CustomCompositions} from './customizations/CustomCompositions';\nexport {registerCustomComponents} from './customizations/registerCustomComponents';",
      )
      mkdirSync(join(staging, 'src', 'customizations'))
      writeFileSync(join(staging, 'src', 'customizations', 'CustomCompositions.tsx'), 'export const CustomCompositions = {};')
      writeFileSync(join(staging, 'src', 'customizations', 'registerCustomComponents.tsx'), 'export function registerCustomComponents() {}')
      writeFileSync(join(staging, 'package.json'), JSON.stringify({name: 'test-valid', version: '0.0.1', files: ['src']}))

      const packOutput = execFileSync('npm', ['pack', '--json'], {cwd: staging, encoding: 'utf8'}).trim()
      const parsed = JSON.parse(packOutput) as {filename: string}[] | {filename: string}
      const packResult = Array.isArray(parsed) ? parsed[0] : parsed
      const tarballPath = join(staging, packResult.filename)

      const tarList = execFileSync('tar', ['-tzf', tarballPath], {encoding: 'utf8'}).trim()
      const entries = tarList.split('\n').filter(Boolean)

      expect(() => assertTarballContents(entries, 'src/index.ts')).not.toThrow()

      const entryPath = findEntryInTarball(entries, 'src/index.ts')
      const content = execFileSync('tar', ['-xzf', tarballPath, '-O', entryPath], {encoding: 'utf8'})
      const contract = validateEntryPointSource(content)
      const stripped = entries.map(e => e.replace(/^package\//, ''))
      expect(() => assertReExportTargetsPacked(contract.reExportSpecifiers, stripped)).not.toThrow()
    } finally {
      rmSync(staging, {recursive: true, force: true})
    }
  })
})

describe('submit validate export semantics', () => {
  it('rejects type-only re-exports of the required names', () => {
    expect(() =>
      validateEntryPointSource("export type {CustomCompositions, registerCustomComponents} from './types';"),
    ).toThrow('named values')
  })

  it('rejects a default export standing in for a required named export', () => {
    expect(() =>
      validateEntryPointSource('export const CustomCompositions = {};\nexport default function registerCustomComponents() {}'),
    ).toThrow('registerCustomComponents')
  })

  it('rejects an entry point with syntax errors', () => {
    expect(() => validateEntryPointSource('export const CustomCompositions = {;')).toThrow('does not parse')
  })

  it('reports re-export specifiers for packed-target resolution', () => {
    const contract = validateEntryPointSource(
      "export {CustomCompositions} from './customizations/CustomCompositions';\nexport {registerCustomComponents} from './customizations/registerCustomComponents';",
    )
    expect(contract.reExportSpecifiers).toEqual([
      './customizations/CustomCompositions',
      './customizations/registerCustomComponents',
    ])
  })

  it('rejects a packed tarball missing a required re-export target', () => {
    expect(() =>
      assertReExportTargetsPacked(['./customizations/registerCustomComponents'], ['src/index.ts', 'src/customizations/CustomCompositions.tsx']),
    ).toThrow('no matching file is in the packed tarball')
  })

  it('rejects non-relative re-export sources', () => {
    expect(() => assertReExportTargetsPacked(['some-package'], ['src/index.ts'])).toThrow('only relative imports')
  })
})

describe('submit pack re-export escape', () => {
  it('rejects a re-export that resolves outside src/', () => {
    expect(() => assertReExportTargetsPacked(['../shared/Foo'], ['src/index.ts'])).toThrow('resolves outside src/')
  })

  it('collapses embedded parent segments before matching', () => {
    expect(() =>
      assertReExportTargetsPacked(['./a/../components/Foo'], ['src/components/Foo.tsx', 'src/index.ts']),
    ).not.toThrow()
  })
})

describe('submit validate entry file kinds', () => {
  it('accepts JSX in a .tsx entry point', () => {
    expect(() =>
      validateEntryPointSource(
        "export const CustomCompositions = () => <root/>;\nexport function registerCustomComponents() {}",
        'index.tsx',
      ),
    ).not.toThrow()
  })

  it('rejects declared-only exports (no runtime binding)', () => {
    expect(() =>
      validateEntryPointSource(
        'export declare const CustomCompositions: unknown;\nexport declare function registerCustomComponents(): void;',
      ),
    ).toThrow('named values')
  })
})

describe('readPlatformVersionFromLockfile', () => {
  const projectWith = (packages: Record<string, {version?: string}>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lock-'))
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages}))
    return dir
  }

  it('reads the installed @reactivapp/mobile version', () => {
    expect(readPlatformVersionFromLockfile(projectWith({'node_modules/@reactivapp/mobile': {version: '2609.23.1'}}))).toBe('2609.23.1')
  })

  it('fails when the platform package is not installed', () => {
    expect(() => readPlatformVersionFromLockfile(projectWith({}))).toThrow('@reactivapp/mobile not found in app/package-lock.json')
  })
})
