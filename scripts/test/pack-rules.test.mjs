import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {describe, it} from 'node:test'
import {fileURLToPath} from 'node:url'

import {
  checkPackedManifest,
  compileSecretPatterns,
  extractHosts,
  findDisallowedEntries,
  findEndpointProblems,
  findMissingTargets,
  findSecrets,
  globToRegExp,
} from '../lib/pack-rules.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/pack-allowlist.json'), 'utf8'))
const patterns = compileSecretPatterns(fs.readFileSync(path.join(repoRoot, 'scripts/secret-patterns.ere'), 'utf8'))
const cli = config.packages['packages/cli']

const file = relative => ({path: `package/${relative}`, type: 'file'})

// Seeded values are assembled through these helpers, which the scan's constant
// folding does not see, so this file never contains a literal it would flag.
const empty = ''
const dot = '.'
const colon = ':'
const concat = (...parts) => parts.join(empty)
const dotted = (...parts) => parts.join(dot)

describe('files whitelist', () => {
  it('passes the expected CLI tarball', () => {
    const entries = ['package.json', 'bin/run', 'dist/index.js', 'dist/commands/app/submit.js'].map(file)
    assert.deepEqual(findDisallowedEntries(entries, cli.entries), [])
  })

  it('fails on anything outside the whitelist', () => {
    const entries = ['package.json', 'dist/index.js', 'dist/index.js.map', 'src/index.ts', '.npmrc', 'test/x.test.ts', 'oclif.manifest.json'].map(file)
    const problems = findDisallowedEntries(entries, cli.entries)
    assert.equal(problems.length, 5)
    for (const name of ['index.js.map', 'src/index.ts', '.npmrc', 'test/x.test.ts', 'oclif.manifest.json']) {
      assert.ok(problems.some(problem => problem.includes(name)), `expected a problem for ${name}`)
    }
  })

  it('fails on links, traversal and entries outside package/', () => {
    const problems = findDisallowedEntries(
      [
        {path: 'package/dist/evil.js', type: 'symlink'},
        {path: 'package/dist/../../etc.js', type: 'file'},
        {path: 'other/dist/index.js', type: 'file'},
      ],
      cli.entries,
    )
    assert.equal(problems.length, 3)
  })

  it('globs match nested paths only where ** allows', () => {
    assert.ok(globToRegExp('dist/**/*.js').test('dist/index.js'))
    assert.ok(globToRegExp('dist/**/*.js').test('dist/a/b/c.js'))
    assert.ok(!globToRegExp('dist/**/*.js').test('dist/a.js.map'))
    assert.ok(!globToRegExp('bin/run').test('bin/run2'))
    assert.ok(globToRegExp('dist/**').test('dist/a/b.js'))
    assert.ok(!globToRegExp('dist/**').test('src/a.js'))
  })
})

describe('packed package.json', () => {
  const good = {name: '@reactivapp/cli', files: ['dist', 'bin/run'], dependencies: {'@oclif/core': '^4.11.0', '@reactivapp/cli-ui': '0.1.0'}}

  it('passes a clean manifest', () => {
    assert.deepEqual(checkPackedManifest(good, cli), [])
  })

  it('fails when files drifts from the gate', () => {
    assert.equal(checkPackedManifest({...good, files: ['bin', 'dist', 'src']}, cli).length, 1)
  })

  it('fails on install-time scripts, workspace ranges and a pinned registry', () => {
    const problems = checkPackedManifest(
      {
        ...good,
        scripts: {postinstall: 'node x.js', test: 'vitest'},
        dependencies: {'@reactivapp/cli-ui': 'workspace:*', other: 'git+https://example.test/x.git'},
        publishConfig: {registry: 'https://example.test/'},
      },
      cli,
    )
    assert.equal(problems.length, 4)
  })

  it('rejects every non-registry specifier form and accepts registry ones', () => {
    const nonRegistry = [
      'gitlab:team/pkg', 'bitbucket:team/pkg', 'team/pkg', './local', 'https://example.test/x.tgz',
      'file:../x', 'link:../x', 'portal:../x', '.', '..', '~', 'artifact.tgz', 'artifact.tar.gz', 'artifact.tar',
    ]
    for (const specifier of nonRegistry) {
      assert.equal(checkPackedManifest({...good, dependencies: {helper: specifier}}, cli).length, 1, specifier)
    }
    const registry = ['^1.2.3', '>=1 <2', '1.x || 2', 'latest', '*', 'npm:other@^1.0.0']
    for (const specifier of registry) {
      assert.deepEqual(checkPackedManifest({...good, dependencies: {helper: specifier}}, cli), [], specifier)
    }
  })

  it('fails when a manifest target or every JavaScript file is missing from the tarball', () => {
    const packed = ['package.json', 'bin/run', 'dist/index.js', 'dist/commands/app/submit.js']
    const withTargets = {...good, main: 'dist/index.js', bin: {reactiv: './bin/run'}, exports: {'.': {default: './dist/index.js', types: './dist/index.d.ts'}}}
    assert.equal(findMissingTargets(withTargets, packed).length, 1)
    assert.deepEqual(findMissingTargets({...withTargets, exports: {'.': {default: './dist/index.js'}}}, packed), [])
    assert.equal(findMissingTargets({...good, main: 'dist/index.js'}, ['package.json', 'LICENSE']).length, 2)
    assert.equal(checkPackedManifest({...good, main: 'dist/index.js'}, cli, ['package/package.json']).length, 2)
  })

  it('fails on the wrong name or a private package', () => {
    assert.equal(checkPackedManifest({...good, name: '@reactivapp/other', private: true}, cli).length, 2)
  })
})

describe('secret scan (scripts/secret-patterns.ere)', () => {
  // Built at runtime so this file never contains a literal that matches.
  const samples = {
    'AWS access key': concat('AKIA', 'ABCDEFGHIJKLMNOP'),
    'GitHub classic token': 'ghp_' + 'a'.repeat(36),
    'GitHub OAuth token': 'gho_' + 'c'.repeat(36),
    'GitHub user-to-server token': 'ghu_' + 'd'.repeat(36),
    'GitHub server-to-server token': 'ghs_' + 'e'.repeat(36),
    'GitHub refresh token': 'ghr_' + 'f'.repeat(36),
    'GitHub fine-grained token': concat('github_', 'pat_', 'x'),
    'npm token': 'npm_' + 'b'.repeat(36),
    'PEM header': concat('-----', 'BEGIN PRIVATE KEY-----'),
    'AWS secret key name': concat('aws_secret_', 'access_key = x'),
    'AWS secret key env name': concat('AWS_SECRET_', 'ACCESS_KEY=x'),
    // A secret may legitimately end in `-`, which is why the pattern's right boundary is explicit.
    'Reactiv Plus API key': 'rpk_' + '01J8ZQ4W6R8V2X9N3M5K7T1P0C' + '_' + 'A'.repeat(42) + '-',
    'Shopify access token': concat('shpat_', 'f'.repeat(32)),
  }

  for (const [label, sample] of Object.entries(samples)) {
    it(`flags a ${label}`, () => {
      assert.equal(findSecrets('dist/x.js', `const a = 1\nconst b = "${sample}"\n`, patterns).length, 1)
    })
  }

  it('reports location without echoing the secret', () => {
    const [problem] = findSecrets('dist/x.js', `x\n${samples['npm token']}`, patterns)
    assert.match(problem, /^dist\/x\.js:2:/)
    assert.ok(!problem.includes(samples['npm token']))
  })

  it('does not flag a Reactiv Plus key id on its own', () => {
    assert.deepEqual(findSecrets('dist/x.js', `const id = "${'rpk_' + '01J8ZQ4W6R8V2X9N3M5K7T1P0C'}"\n`, patterns), [])
  })

  it('passes clean content', () => {
    assert.deepEqual(findSecrets('dist/x.js', 'export const a = "npm view"\n', patterns), [])
  })
})

describe('endpoint allowlist', () => {
  it('passes allowed hosts', () => {
    const content = "http.get({host: '127.0.0.1'}); fetch('https://plus-devtools-staging.dev.reactivapp.com/v1/me'); 'git+https://github.com/reactivapp/cli.git'"
    assert.deepEqual(findEndpointProblems('dist/x.js', content, config.allowedHosts), [])
  })

  it('flags an unknown hostname with or without a scheme', () => {
    assert.equal(findEndpointProblems('dist/x.js', "fetch('https://api.example.test/v1')", config.allowedHosts).length, 1)
    assert.equal(findEndpointProblems('dist/x.js', `const host = '${dotted('vending', 'reactiv', 'ai')}'`, config.allowedHosts).length, 1)
  })

  it('flags internal infrastructure even when split across a template string', () => {
    const content = 'const url = `https://${domain}-000000000000.d.codeartifact.us-east-1.amazonaws.com/npm/${repo}/`'
    const problems = findEndpointProblems('dist/x.js', content, config.allowedHosts)
    assert.ok(problems.some(problem => problem.includes('internal infrastructure')))
  })

  it('exempts only the exact allowlisted literals, never the same marker elsewhere', () => {
    const literal = config.allowedLiterals[0].literal
    assert.deepEqual(findEndpointProblems('dist/x.js', `const shape = ${literal};`, config.allowedHosts, config.allowedLiterals), [])
    const problems = findEndpointProblems(
      'dist/x.js',
      `const shape = ${literal};\nconst url = 'reactivapp-000000000000.d.codeartifact.us-east-1.amazonaws.com'`,
      config.allowedHosts,
      config.allowedLiterals,
    )
    assert.ok(problems.some(problem => problem.includes('internal infrastructure')))
  })

  it('reads the host, not the userinfo, from a URL', () => {
    const hosts = extractHosts(`'git+https://git@${dotted('github', 'com')}/reactivapp/cli.git' 'https://user:pw@api.example.test/v1'`)
    assert.deepEqual([...hosts].sort(), ['api.example.test', 'github.com'])
  })

  it('extracts IP literals', () => {
    const ip = dotted('10', '0', '0', '12')
    assert.ok(extractHosts(`connect("${ip}")`).has(ip))
    const v6Literal = `[${['fd12', '3456', '', '1'].join(colon)}]`
    const v6 = extractHosts(`connect to [::1]:8081 or ${v6Literal}:443`)
    assert.ok(v6.has('[::1]') && v6.has(v6Literal))
  })

  it('flags bare hostnames on country and newer TLDs', () => {
    assert.ok(extractHosts(`const api = '${dotted('staging', 'reactiv', 'tech')}'`).has(dotted('staging', 'reactiv', 'tech')))
    assert.ok(extractHosts(`const api = '${dotted('api', 'reactiv', 'ca')}'`).has(dotted('api', 'reactiv', 'ca')))
  })

  it('does not treat a bundle identifier or file name as a host', () => {
    assert.deepEqual([...extractHosts('`com.reactiv.${slug}` reactiv.conf.js .reactiv-metro.log')], [])
    assert.deepEqual([...extractHosts('if ("link" in token) return token.link.url; lib.so')], [])
  })
})
