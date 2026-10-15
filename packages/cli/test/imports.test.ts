import {describe, expect, it} from 'vitest'

import {collectSourceImports, crossCheckImports, packageRoot} from '../src/lib/imports'

const platform = new Set(['@reactivapp/mobile', 'react', 'react-native', 'react-native-reanimated'])

const check = (sources: Record<string, string>, declared: Record<string, string> = {}) =>
  crossCheckImports(
    Object.entries(sources).map(([file, source]) => ({file, source})),
    declared,
    platform,
  )

describe('packageRoot', () => {
  it('maps plain, subpath and scoped specifiers to the package name', () => {
    expect(packageRoot('date-fns')).toBe('date-fns')
    expect(packageRoot('date-fns/format')).toBe('date-fns')
    expect(packageRoot('@scope/pkg')).toBe('@scope/pkg')
    expect(packageRoot('@scope/pkg/deep/path')).toBe('@scope/pkg')
  })
})

describe('collectSourceImports', () => {
  it('collects every static, re-export, dynamic, require and type-level form with its line', () => {
    const {references, uncheckable} = collectSourceImports(
      [
        "import a from 'a'",
        "import type {B} from 'b'",
        "export {c} from 'c'",
        "export * from 'd'",
        "const e = import('e')",
        "const f = require('f')",
        "const g = require.resolve('g')",
        "import h = require('h')",
        "type I = import('i').I",
        'const j = require(`j`)',
        "import './side-effect'",
        "export type * from 'k'",
      ].join('\n'),
      'src/all.ts',
    )
    expect(uncheckable).toEqual([])
    expect(references).toEqual([
      {specifier: 'a', line: 1},
      {specifier: 'b', line: 2},
      {specifier: 'c', line: 3},
      {specifier: 'd', line: 4},
      {specifier: 'e', line: 5},
      {specifier: 'f', line: 6},
      {specifier: 'g', line: 7},
      {specifier: 'h', line: 8},
      {specifier: 'i', line: 9},
      {specifier: 'j', line: 10},
      {specifier: './side-effect', line: 11},
      {specifier: 'k', line: 12},
    ])
  })

  it('flags computed specifiers and require used as a value', () => {
    const {references, uncheckable} = collectSourceImports(
      [
        'const name = "x"',
        'import(name)',
        'require(`pkg-${name}`)',
        'const load = require',
        "module['require']('y')",
        "module.require('z')",
        'require.resolve(name)',
        'class Loader { require(id: string) {} }',
        'const {require: own} = globalThis as any',
      ].join('\n'),
      'src/dynamic.ts',
    )
    expect(references).toEqual([])
    expect(uncheckable).toEqual([
      {line: 2, form: 'import()'},
      {line: 3, form: 'require()'},
      {line: 4, form: 'require used other than as a direct call'},
      {line: 5, form: 'require reached through property access'},
      {line: 6, form: 'require used other than as a direct call'},
      {line: 7, form: 'require.resolve()'},
      {line: 8, form: 'require used other than as a direct call'},
      {line: 9, form: 'require used other than as a direct call'},
    ])
  })

  it('flags computed specifiers and require used as a value in JavaScript', () => {
    const {references, uncheckable} = collectSourceImports(
      [
        'const name = "x"',
        'import(name)',
        'require(`pkg-${name}`)',
        'const load = require',
        "module['require']('y')",
        "module.require('z')",
        'require.resolve(name)',
      ].join('\n'),
      'src/dynamic.js',
    )
    expect(references).toEqual([])
    expect(uncheckable).toEqual([
      {line: 2, form: 'import()'},
      {line: 3, form: 'require()'},
      {line: 4, form: 'require used other than as a direct call'},
      {line: 5, form: 'require reached through property access'},
      {line: 6, form: 'require used other than as a direct call'},
      {line: 7, form: 'require.resolve()'},
    ])
  })

  it('flags import.meta in any form', () => {
    const {references, uncheckable} = collectSourceImports("const a = import.meta.resolve('x')\nconst b = import.meta.url\nconst c = import.meta\n", 'src/meta.mjs')
    expect(references).toEqual([])
    expect(uncheckable).toEqual([
      {line: 1, form: 'import.meta is not available in the app runtime'},
      {line: 2, form: 'import.meta is not available in the app runtime'},
      {line: 3, form: 'import.meta is not available in the app runtime'},
    ])
  })

  it('parses JSX in .js and .tsx files', () => {
    expect(collectSourceImports("import React from 'react'\nexport const A = () => <div />\n", 'src/a.js').references).toEqual([{specifier: 'react', line: 1}])
    expect(collectSourceImports("import {View} from 'react-native'\nexport const B = () => <View />\n", 'src/b.tsx').references).toEqual([
      {specifier: 'react-native', line: 1},
    ])
  })

  it('parses the module and CommonJS variants of both languages', () => {
    expect(collectSourceImports("import x from 'm'\nconst n: number = 1\n", 'src/a.mts').references).toEqual([{specifier: 'm', line: 1}])
    expect(collectSourceImports("import x = require('c')\nconst n: number = 1\n", 'src/a.cts').references).toEqual([{specifier: 'c', line: 1}])
    expect(collectSourceImports("export {x} from 'mj'\n", 'src/a.mjs').references).toEqual([{specifier: 'mj', line: 1}])
    expect(collectSourceImports("const c = require('cj')\n", 'src/a.cjs').references).toEqual([{specifier: 'cj', line: 1}])
    expect(collectSourceImports("import type {T} from 't'\nexport declare const v: T\n", 'src/types.d.ts').references).toEqual([{specifier: 't', line: 1}])
  })

  it('refuses a file that does not parse', () => {
    expect(() => collectSourceImports('import {', 'src/broken.ts')).toThrow('src/broken.ts does not parse')
  })
})

describe('crossCheckImports', () => {
  it('passes declared, platform-provided and relative imports, including subpaths and scoped packages', () => {
    expect(
      check(
        {
          'src/index.ts': "export {x} from './x'\nimport {format} from 'date-fns/format'\nimport {Pkg} from '@scope/pkg/sub'\n",
          'src/x.tsx': "import {View} from 'react-native'\nimport {useSharedValue} from 'react-native-reanimated'\nimport {mobile} from '@reactivapp/mobile'\nexport const x = 1\n",
        },
        {'date-fns': '4.1.0', '@scope/pkg': '1.0.0'},
      ),
    ).toEqual({errors: [], warnings: []})
  })

  it('rejects subpaths into platform packages but allows them into declared dependencies', () => {
    expect(check({'src/a.ts': "import {format} from 'date-fns/format'\nimport {x} from '@scope/pkg/sub'\n"}, {'date-fns': '4.1.0', '@scope/pkg': '1.0.0'})).toEqual({
      errors: [],
      warnings: [],
    })
    expect(check({'src/a.ts': "import Platform from 'react-native/Libraries/Utilities/Platform'\nimport {api} from '@reactivapp/mobile/src/api'\n"}).errors).toEqual([
      'src/ imports internal paths of platform packages:',
      '  "react-native/Libraries/Utilities/Platform" in src/a.ts:1 — platform packages expose only their public entry; import from "react-native"',
      '  "@reactivapp/mobile/src/api" in src/a.ts:2 — platform packages expose only their public entry; import from "@reactivapp/mobile"',
    ])
  })

  it('passes the platform aliases exactly and rejects their subpaths', () => {
    const supplied = new Set([...platform, '@reactiv-mobile-core', '@reactiv-mobile-core-framework', '@scope/alias'])
    const source = [
      "import {useX} from '@reactiv-mobile-core'",
      "import {reg} from '@reactiv-mobile-core-framework'",
      "import {deep} from '@reactiv-mobile-core/src/hooks'",
      "import {kit} from '@reactiv-mobile-ui-kit'",
      "import {named} from '@scope/alias'",
      "import {inner} from '@scope/alias/inner'",
      "import {slash} from '@reactiv-mobile-core/'",
      '',
    ].join('\n')
    expect(crossCheckImports([{file: 'src/a.ts', source}], {}, supplied)).toEqual({
      errors: [
        'src/ imports internal paths of platform packages:',
        '  "@reactiv-mobile-core/src/hooks" in src/a.ts:3 — platform packages expose only their public entry; import from "@reactiv-mobile-core"',
        '  "@scope/alias/inner" in src/a.ts:6 — platform packages expose only their public entry; import from "@scope/alias"',
        '  "@reactiv-mobile-core/" in src/a.ts:7 — platform packages expose only their public entry; import from "@reactiv-mobile-core"',
        'src/ imports paths that are not packages:',
        '  "@reactiv-mobile-ui-kit" in src/a.ts:4 — not a valid package name',
      ],
      warnings: [],
    })
  })

  it('rejects an undeclared package with every place it is imported and the install fix', () => {
    const {errors} = check({
      'src/a.ts': "import lodash from 'lodash'\n",
      'src/b.ts': "\nimport {map} from 'lodash/fp'\n",
      'src/c.ts': "export * from '@scope/missing/sub'\n",
    })
    expect(errors).toEqual([
      'src/ imports packages that package.json does not declare:',
      '  @scope/missing: "@scope/missing/sub" in src/c.ts:1 — run `npm install --save-exact @scope/missing@<version>` at the project root and in app/',
      '  lodash: "lodash" in src/a.ts:1, "lodash/fp" in src/b.ts:2 — run `npm install --save-exact lodash@<version>` at the project root and in app/',
    ])
  })

  it('rejects undeclared packages reached through export from, dynamic import and require', () => {
    const {errors} = check({'src/a.ts': "export {a} from 'one'\nconst b = import('two')\nconst c = require('three')\nconst d = require.resolve('four')\nexport * as ns from 'five'\n"})
    expect(errors.join('\n')).toContain('five: "five" in src/a.ts:5')
    expect(errors.join('\n')).toContain('four: "four" in src/a.ts:4')
    expect(errors.join('\n')).toContain('one: "one" in src/a.ts:1')
    expect(errors.join('\n')).toContain('two: "two" in src/a.ts:2')
    expect(errors.join('\n')).toContain('three: "three" in src/a.ts:3')
  })

  it('warns once per declared package nothing imports, without failing', () => {
    expect(check({'src/a.ts': "import {format} from 'date-fns'\n"}, {'date-fns': '4.1.0', 'left-pad': '1.3.0', axios: '1.7.9'})).toEqual({
      errors: [],
      warnings: [
        'package.json declares axios but nothing in src/ imports it — if nothing needs it, remove it from package.json and app/package.json (it ships with the submission)',
        'package.json declares left-pad but nothing in src/ imports it — if nothing needs it, remove it from package.json and app/package.json (it ships with the submission)',
      ],
    })
  })

  it('rejects non-literal specifiers with file and line', () => {
    const {errors} = check({'src/a.ts': "const name = 'x'\nexport const load = () => import(name)\n"})
    expect(errors).toEqual([
      'src/ loads modules the dependency check cannot read — imports must be string literals and require may only be called directly:',
      '  src/a.ts:2 — import()',
    ])
  })

  it('rejects Node built-ins, with or without the node: prefix', () => {
    const {errors} = check({'src/a.ts': "import * as fs from 'node:fs'\nimport path from 'path'\nimport {readFile} from 'fs/promises'\n"})
    expect(errors).toEqual([
      'src/ imports Node built-in modules, which do not exist in the app runtime (Hermes):',
      '  "node:fs" in src/a.ts:1 — remove the import',
      '  "path" in src/a.ts:2 — remove the import, or if you meant the npm package "path", run `npm install --save-exact path@<version>` at the project root and in app/',
      '  "fs/promises" in src/a.ts:3 — remove the import, or if you meant the npm package "fs", run `npm install --save-exact fs@<version>` at the project root and in app/',
    ])
  })

  it('accepts the npm package that shares a built-in name once it is declared, but never the node: form', () => {
    expect(check({'src/a.ts': "import {Buffer} from 'buffer'\n"}, {buffer: '6.0.3'})).toEqual({errors: [], warnings: []})
    expect(check({'src/a.ts': "import {Buffer} from 'node:buffer'\n"}, {buffer: '6.0.3'}).errors).toContain(
      '  "node:buffer" in src/a.ts:1 — import "buffer" instead; the declared npm package of that name is what runs in the app',
    )
  })

  it('rejects node:fs even when a package named fs is declared', () => {
    expect(check({'src/a.ts': "import {readFile} from 'node:fs'\n"}, {fs: '0.0.1-security'}).errors).toEqual([
      'src/ imports Node built-in modules, which do not exist in the app runtime (Hermes):',
      '  "node:fs" in src/a.ts:1 — import "fs" instead; the declared npm package of that name is what runs in the app',
    ])
  })

  it('maps a built-in subpath to its root, allowed once the polyfill is declared', () => {
    expect(check({'src/a.ts': "import {types} from 'util/types'\n"}, {util: '0.12.5'})).toEqual({errors: [], warnings: []})
  })

  it('treats a polyfill listed only as a peer as undeclared', () => {
    expect(check({'src/a.ts': "import {Buffer} from 'buffer'\n"}).errors).toEqual([
      'src/ imports Node built-in modules, which do not exist in the app runtime (Hermes):',
      '  "buffer" in src/a.ts:1 — remove the import, or if you meant the npm package "buffer", run `npm install --save-exact buffer@<version>` at the project root and in app/',
    ])
  })

  it('rejects absolute paths and URL specifiers', () => {
    const {errors} = check({'src/a.ts': "import a from '/etc/thing'\nimport b from 'https://example.invalid/b.js'\n"})
    expect(errors).toEqual([
      'src/ imports paths that are not packages:',
      '  "/etc/thing" in src/a.ts:1 — import files inside src/ by relative path, or a declared package by name',
      '  "https://example.invalid/b.js" in src/a.ts:2 — import files inside src/ by relative path, or a declared package by name',
    ])
  })

  it('rejects package.json "imports" aliases and malformed package names', () => {
    const {errors} = check({'src/a.ts': "import a from '#utils/helper'\nimport b from '@scope'\nimport c from '@scope/'\nimport d from ''\nimport e from 'lodash?query'\nimport f from 'pkg#sub'\nimport g from '@sco?pe/pkg'\nimport h from '@scope/pk#g'\n"})
    expect(errors).toEqual([
      'src/ imports paths that are not packages:',
      '  "#utils/helper" in src/a.ts:1 — package.json "imports" aliases are not part of a submission; import the file by relative path',
      '  "@scope" in src/a.ts:2 — not a valid package name',
      '  "@scope/" in src/a.ts:3 — not a valid package name',
      '  "" in src/a.ts:4 — not a valid package name',
      '  "lodash?query" in src/a.ts:5 — not a valid package name',
      '  "pkg#sub" in src/a.ts:6 — not a valid package name',
      '  "@sco?pe/pkg" in src/a.ts:7 — not a valid package name',
      '  "@scope/pk#g" in src/a.ts:8 — not a valid package name',
    ])
  })

  it('rejects . and .. segments after a package name, even when the package is declared', () => {
    const {errors, warnings} = check(
      {'src/a.ts': "import x from 'date-fns/../lodash'\nimport y from '@scope/pkg/./sub'\nimport z from 'date-fns/format/..'\n"},
      {'date-fns': '4.1.0', '@scope/pkg': '1.0.0'},
    )
    expect(errors).toEqual([
      'src/ imports paths that are not packages:',
      '  "date-fns/../lodash" in src/a.ts:1 — "." and ".." segments would leave the package "date-fns"; import the package or one of its own files',
      '  "@scope/pkg/./sub" in src/a.ts:2 — "." and ".." segments would leave the package "@scope/pkg"; import the package or one of its own files',
      '  "date-fns/format/.." in src/a.ts:3 — "." and ".." segments would leave the package "date-fns"; import the package or one of its own files',
    ])
    expect(warnings).toHaveLength(2)
  })

  it('rejects relative imports that leave src/', () => {
    const {errors} = check({'src/deep/a.ts': "import cfg from '../../config'\nimport pkg from '../../package.json'\nimport ok from '../b'\n", 'src/b.ts': ''})
    expect(errors).toEqual([
      'src/ imports files outside src/, which a submission does not pack:',
      '  "../../config" in src/deep/a.ts:1 — resolves to config; move the file inside src/',
      '  "../../package.json" in src/deep/a.ts:2 — resolves to package.json; move the file inside src/',
    ])
  })

  it('keeps scanning the other files when one does not parse', () => {
    const {errors} = check({'src/a.ts': 'import {\n', 'src/b.ts': "import 'missing'\n"})
    expect(errors[0]).toBe('src/ files that do not parse, so their imports cannot be checked:')
    expect(errors[1]).toContain('src/a.ts does not parse')
    expect(errors).toContain('src/ imports packages that package.json does not declare:')
  })

  it('warns about every declared dependency when src/ has no source files', () => {
    expect(crossCheckImports([], {'date-fns': '4.1.0'}, platform)).toEqual({
      errors: [],
      warnings: ['package.json declares date-fns but nothing in src/ imports it — if nothing needs it, remove it from package.json and app/package.json (it ships with the submission)'],
    })
  })

  it('reports every category at once', () => {
    const {errors} = check({
      'src/a.ts': "import 'missing'\nimport 'node:os'\nimport '/abs'\nimport '../outside'\nimport 'react-native/internal'\nrequire(name)\n",
      'src/b.ts': 'import {\n',
    })
    expect(errors.filter(line => !line.startsWith('  '))).toEqual([
      'src/ files that do not parse, so their imports cannot be checked:',
      'src/ imports packages that package.json does not declare:',
      'src/ imports internal paths of platform packages:',
      'src/ imports Node built-in modules, which do not exist in the app runtime (Hermes):',
      'src/ imports paths that are not packages:',
      'src/ imports files outside src/, which a submission does not pack:',
      'src/ loads modules the dependency check cannot read — imports must be string literals and require may only be called directly:',
    ])
  })
})
