import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, it} from 'node:test'
import {fileURLToPath} from 'node:url'

import {execFileSync} from 'node:child_process'

import {
  decodeContent,
  findAccountIds,
  findEncodedSecrets,
  findInternalMarkers,
  findSecretsInPatternFile,
  findTrackerIds,
  findUnknownEmails,
  findUnknownHosts,
  findUnknownLinks,
  joinStringConstants,
  PLACEHOLDER_ACCOUNT_ID,
  redactProblems,
  scanContent,
  scanPath,
} from '../lib/internal-reference-rules.mjs'
import {scanHistory, scanMessages, scanTree} from '../internal-reference-scan.mjs'
import {compileSecretPatterns} from '../lib/pack-rules.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/internal-reference-allowlist.json'), 'utf8'))
const patternSource = fs.readFileSync(path.join(repoRoot, 'scripts/secret-patterns.ere'), 'utf8')
const secretPatterns = compileSecretPatterns(patternSource)

// Seeded values are assembled through these helpers, which the scan's constant
// folding does not see, so this file never contains a literal it would flag.
const empty = ''
const dot = '.'
const colon = ':'
const concat = (...parts) => parts.join(empty)
const dotted = (...parts) => parts.join(dot)
const aws = concat('amazon', dotted('aws', 'com'))
const artifact = concat('code', 'artifact')
const seededId = concat('1234', '5678', '9012')
const seededHost = dotted(`reactivapp-${seededId}`, 'd', artifact, 'us-east-1', aws)
const placeholderHost = dotted(`reactivapp-${PLACEHOLDER_ACCOUNT_ID}`, 'd', artifact, 'us-east-1', aws)
const arn = ['arn', 'aws', 'iam', '', seededId, 'role/deploy'].join(colon)
const privateHost = dotted('db', 'corp', 'internal')
const forge = dotted('github', 'com')
const companyHost = suffix => dotted('build', 'reactivapp', suffix)
const token = concat('npm_', 'a'.repeat(36))
const accessKeyId = concat('AKIA', 'B'.repeat(16))
const ticket = digits => concat('sc-', digits)
const encoded = Buffer.from(token).toString('base64')

const git = (root, args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', env: {...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test'}})
const commitAll = (root, message) => {
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '--allow-empty', '-m', message])
  return git(root, ['rev-parse', 'HEAD']).trim()
}
const temporaryRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-history-'))
  git(root, ['init', '-q', '-b', 'main'])
  return root
}

describe('account ids and ARNs', () => {
  it('flags any 12-digit run, with or without context, next to letters or underscores', () => {
    assert.equal(findAccountIds('docs/x.md', `registry ${seededHost}\n`).length, 1)
    assert.equal(findAccountIds('docs/x.md', `owner: ${seededId}\n`).length, 1)
    assert.equal(findAccountIds('docs/x.md', `account_id:\n  ${seededId}\n`).length, 1)
    assert.equal(findAccountIds('docs/x.md', `account_${seededId}\n`).length, 1)
    assert.equal(findAccountIds('docs/x.md', `"${seededId.slice(0, 6)}" + "${seededId.slice(6)}"\n`).length, 1)
  })

  it('flags an ARN', () => {
    assert.equal(findAccountIds('x.yml', `role: ${arn}\n`).filter(problem => problem.includes('AWS ARN')).length, 1)
  })

  it('accepts the placeholder id, digit runs inside UUIDs and hex digests, longer digit runs, and listed exceptions', () => {
    assert.deepEqual(findAccountIds('x.ts', `${placeholderHost}\n`), [])
    assert.deepEqual(findAccountIds('x.ts', 'uuid 11111111-1111-1111-1111-111111111111\n'), [])
    assert.deepEqual(findAccountIds('x.ts', `uses: actions/checkout@${'1'.repeat(12)}${'a'.repeat(28)}\n`), [])
    assert.deepEqual(findAccountIds('x.ts', `version ${seededId}${seededId}.0.0\n`), [])
    assert.deepEqual(findAccountIds('x.ts', `const size = ${seededId}\n`, [seededId]), [])
  })
})

describe('internal markers', () => {
  it('flags every marker outside the definition paths, one problem per marker', () => {
    const problems = findInternalMarkers('README.md', `install from ${seededHost}\n`, config)
    assert.equal(problems.length, 3)
    for (const problem of problems) assert.match(problem, /^README\.md:1: internal infrastructure marker/)
    assert.equal(findInternalMarkers('src/x.ts', `const h = "${privateHost}"\n`, config).length, 1)
  })

  it('lets fixtures name the registry service and the placeholder host, nothing more', () => {
    const fixture = 'packages/cli/test/helpers/fixtures.ts'
    assert.deepEqual(findInternalMarkers(fixture, `${placeholderHost}\n`, config), [])
    assert.equal(findInternalMarkers(fixture, `${seededHost}\n`, config).length, 1)
    assert.equal(findInternalMarkers(fixture, `${privateHost}\n`, config).length, 1)
    assert.equal(findInternalMarkers('packages/cli/src/lib/npm.ts', `${placeholderHost}\n`, config).length, 3)
  })

  it('sees through split string constants, across lines too', () => {
    assert.equal(findInternalMarkers('src/x.ts', `const h = "${aws.slice(0, 6)}" + "${aws.slice(6)}"\n`, config).length, 1)
    assert.equal(findInternalMarkers('src/x.ts', `const h = "${artifact.slice(0, 4)}" +\n  "${artifact.slice(4)}"\n`, config).length, 1)
  })

  it('allows a definition file its exact reviewed lines and nothing more', () => {
    const file = 'scripts/lib/pack-rules.mjs'
    const reviewed = config.allowedMarkerLines.find(entry => entry.path === file).line
    assert.deepEqual(findInternalMarkers(file, `${reviewed}\n`, config), [])
    assert.equal(findInternalMarkers(file, `${reviewed}\n// ${artifact} repository: private-registry\n`, config).length, 1)
  })
})

describe('hostnames', () => {
  it('flags a hostname missing from the allowlist, with or without a scheme, in any path, also when split', () => {
    assert.equal(findUnknownHosts('x.md', `see https://${companyHost('com')}/v1\n`, config.allowedHosts).length, 1)
    assert.equal(findUnknownHosts('packages/cli/test/x.test.ts', `const host = "${companyHost('com')}"\n`, config.allowedHosts).length, 1)
    assert.equal(findUnknownHosts('x.md', `const host = "${companyHost('tools')}"\n`, config.allowedHosts).length, 1)
    assert.equal(findUnknownHosts('x.md', `const host = "${companyHost('com').slice(0, 10)}" + "${companyHost('com').slice(10)}"\n`, config.allowedHosts).length, 1)
    assert.equal(findUnknownHosts('x.md', `const host = ["${companyHost('com').slice(0, 10)}", "${companyHost('com').slice(10)}"].join("")\n`, config.allowedHosts).length, 1)
  })

  it('accepts allowlisted, fictional and placeholder-registry hosts', () => {
    const content = `https://github.com/reactivapp/cli https://terms.example.test/x http://127.0.0.1:4010 https://registry.example/npm/ jane@example.com ${placeholderHost}\n`
    assert.deepEqual(findUnknownHosts('x.md', content, config.allowedHosts), [])
  })

  it('ignores template placeholders, truncated literals and bare shell script names, but not .sh URL hosts', () => {
    assert.deepEqual(findUnknownHosts('x.md', 'https://${REGISTRY_HOST}/npm/ http://[::1 sh setup.sh scripts/secret-scan.sh\n', config.allowedHosts), [])
    assert.equal(findUnknownHosts('x.md', `https://${dotted('build', 'reactiv', 'sh')}/private\n`, config.allowedHosts).length, 1)
  })

  it('scans every line of the lockfile, deprecation notices included', () => {
    assert.equal(findUnknownHosts('pnpm-lock.yaml', `    resolution: {tarball: https://${companyHost('com')}/private.tgz}\n`, config.allowedHosts).length, 1)
    assert.equal(findUnknownHosts('pnpm-lock.yaml', `    deprecated: see https://${companyHost('com')}/notice\n`, config.allowedHosts).length, 1)
  })
})

describe('links and addresses', () => {
  it('limits links on the forge to the reviewed repositories, in every URL form, without echoing userinfo', () => {
    assert.deepEqual(findUnknownLinks('x.md', 'https://github.com/reactivapp/cli/pull/1 git+https://git@github.com/reactivapp/cli.git ssh://git@github.com/reactivapp/cli.git git@github.com:reactivapp/cli.git\n', config), [])
    const other = `https://${forge}/reactivapp/other-repo/commit/${'a'.repeat(40)}`
    assert.equal(findUnknownLinks('x.md', `${other}\n`, config).length, 1)
    assert.equal(findUnknownLinks('x.md', `ssh://git@${forge}/reactivapp/other-repo.git\n`, config).length, 1)
    assert.equal(findUnknownLinks('x.md', `git@${forge}:reactivapp/other-repo.git\n`, config).length, 1)
    assert.equal(findUnknownLinks('x.md', `https://${forge}/reactivapp/cli.private/commit/${'a'.repeat(40)}\n`, config).length, 1)
    assert.equal(findUnknownLinks('x.md', `const repo = "https://git" + "${concat('hub', '.com')}/reactivapp/other-repo"\n`, config).length, 1)
    assert.equal(findUnknownLinks('x.md', `//${forge}/reactivapp/other-repo\n`, config).length, 1)
    assert.equal(findUnknownLinks('x.md', `https://${forge}/reactivapp/cli/../../reactivapp/other-repo\n`, config).length, 1)
    assert.deepEqual(findUnknownLinks('x.md', `https://${forge}/reactivapp/cli/./pull/1\n`, config), [])
    const [problem] = findUnknownLinks('x.md', `https://${token}@${forge}/reactivapp/other-repo\n`, config)
    assert.ok(problem && !problem.includes(token))
  })

  it('limits company addresses to the listed ones without echoing the address', () => {
    assert.deepEqual(findUnknownEmails('x.md', 'security@reactiv.ai fixture@example.test\n', config.allowedEmails), [])
    const [problem] = findUnknownEmails('x.md', `${concat('reviewer', '@', dotted('reactiv', 'ai'))}\n`, config.allowedEmails)
    assert.ok(problem && !problem.includes('reviewer'))
    assert.equal(findUnknownEmails('x.md', `"reviewer@" + "${dotted('reactiv', 'ai')}"\n`, config.allowedEmails).length, 1)
  })
})

describe('tracker ids', () => {
  it('flags Shortcut-style story ids of any length and reports every id on a line', () => {
    assert.equal(findTrackerIds('x.md', `see ${ticket('12')} and ${ticket('1234567')}\n`).length, 2)
    assert.deepEqual(findTrackerIds('x.md', 'misc-123 and disc-12345 and sc-x\n'), [])
  })
})

describe('secrets', () => {
  it('finds a credential split across string constants, lines or an array join, or base64-encoded', () => {
    assert.equal(findEncodedSecrets('x.ts', `const t = "${token.slice(0, 4)}" + "${token.slice(4)}"\n`, secretPatterns).length, 1)
    assert.equal(findEncodedSecrets('x.ts', `const t = "${token.slice(0, 4)}" +\n  "${token.slice(4)}"\n`, secretPatterns).length, 1)
    assert.equal(findEncodedSecrets('x.ts', `const t = ["${token.slice(0, 4)}", "${token.slice(4)}"].join("")\n`, secretPatterns).length, 1)
    assert.equal(findEncodedSecrets('x.ts', `const t = "${Buffer.from(token).toString('base64')}"\n`, secretPatterns).length, 1)
    assert.equal(findEncodedSecrets('x.ts', `const t = "${Buffer.from(token).toString('base64url')}"\n`, secretPatterns).length, 1)
    assert.equal(findEncodedSecrets('x.ts', `const k = "${Buffer.from(accessKeyId).toString('base64')}"\n`, secretPatterns).length, 1)
    assert.equal(findEncodedSecrets('x.ts', `const t = "${encoded.slice(0, 16)}" + "${encoded.slice(16)}"\n`, secretPatterns).length, 1)
    assert.deepEqual(findEncodedSecrets('x.ts', 'const t = "npm view"\n', secretPatterns), [])
  })

  it('never echoes the value', () => {
    for (const problem of findEncodedSecrets('x.ts', `${token}\n`, secretPatterns)) assert.ok(!problem.includes(token))
  })

  it('folds nested concatenations and array joins', () => {
    assert.equal(joinStringConstants("'a' + 'b' + 'c'"), "'abc'")
    assert.equal(joinStringConstants("['a', 'b'].join('-')"), "'a-b'")
    assert.equal(joinStringConstants('x + y'), 'x + y')
  })

  it('accepts the pattern files as they are and rejects a credential value added to them, plain, encoded or in place of a pattern', () => {
    assert.deepEqual(findSecretsInPatternFile('scripts/secret-patterns.ere', patternSource), [])
    assert.ok(findSecretsInPatternFile('scripts/secret-patterns.ere', `${patternSource}${token}\n`).length >= 1)
    assert.ok(findSecretsInPatternFile('scripts/secret-patterns.ere', `${patternSource}${encoded}\n`).length >= 1)
    const [, second] = patternSource.split('\n')
    assert.ok(findSecretsInPatternFile('scripts/secret-patterns.ere', `${token}\n${second}\n`).length >= 1)
  })

  it('redacts credential-shaped text from every diagnostic', () => {
    const problems = [...scanPath(`docs/${token}.txt`, config, secretPatterns), ...findUnknownLinks('x.md', `https://${forge}/reactivapp/${token}\n`, config), ...scanPath(`docs/${encoded}.txt`, config, secretPatterns)]
    assert.ok(problems.length >= 3)
    for (const problem of redactProblems(problems, secretPatterns)) {
      assert.ok(!problem.includes(token) && !problem.includes(encoded), problem)
    }
  })
})

describe('scanContent and scanPath', () => {
  it('combines every rule', () => {
    const problems = scanContent('docs/x.md', `${token}\n${arn}\n`, config, secretPatterns)
    assert.ok(problems.some(problem => problem.includes('secret pattern')))
    assert.ok(problems.some(problem => problem.includes('AWS ARN')))
  })

  it('scans names, including credential-shaped and address-shaped ones', () => {
    assert.equal(scanPath(`docs/${ticket('12345')}.md`, config, secretPatterns).length, 1)
    assert.equal(scanPath(`packages/cli/test/${privateHost}.ts`, config, secretPatterns).length, 2)
    assert.equal(scanPath(`docs/${token}.txt`, config, secretPatterns).length, 1)
    assert.equal(scanPath(`docs/${encoded.replace(/=+$/, '')}.txt`, config, secretPatterns).length, 1)
    assert.equal(scanPath(`docs/${concat('reviewer', '@', dotted('reactiv', 'ai'))}.txt`, config, secretPatterns).length, 1)
    assert.deepEqual(scanPath('packages/cli/test/helpers/fixtures.ts', config, secretPatterns), [])
  })

  it('decodes UTF-16 with and without a byte-order mark and reads binary content byte for byte', () => {
    const marked = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`host ${companyHost('com')}`, 'utf16le')])
    assert.equal(findUnknownHosts('x.bin', decodeContent(marked), config.allowedHosts).length, 1)
    const unmarked = Buffer.from(`host ${companyHost('com')} and more text to classify`, 'utf16le')
    assert.equal(findUnknownHosts('x.bin', decodeContent(unmarked), config.allowedHosts).length, 1)
    const bigEndian = Buffer.from(Buffer.from(`host ${companyHost('com')} and more text to classify`, 'utf16le')).swap16()
    assert.equal(findUnknownHosts('x.bin', decodeContent(bigEndian), config.allowedHosts).length, 1)
    const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`https://${companyHost('com')}/`), Buffer.from([0])])
    assert.equal(findUnknownHosts('x.bin', decodeContent(binary), config.allowedHosts).length, 1)
  })
})

describe('the repository', () => {
  it('passes the tree scan', () => {
    const {scanned, problems} = scanTree()
    assert.ok(scanned > 20, `scanned only ${scanned} files`)
    assert.deepEqual(problems, [])
  })

  it('scans commit messages and historical file versions of this repository', () => {
    // A pull request checkout is a forge-made merge commit, so identities are left to the fixture test below.
    const messages = scanMessages('HEAD~1..HEAD', undefined, {identities: false})
    assert.ok(messages.scanned >= 1)
    assert.deepEqual(messages.problems, [])
    assert.deepEqual(scanHistory('HEAD~1..HEAD').problems, [])
  })

  it('finds a forbidden file version that a later commit deleted, in root, ordinary and merge commits', () => {
    const root = temporaryRepo()
    try {
      fs.writeFileSync(path.join(root, 'notes.md'), `registry ${companyHost('com')}\n`)
      const first = commitAll(root, 'root commit')
      fs.rmSync(path.join(root, 'notes.md'))
      const second = commitAll(root, 'delete it')
      git(root, ['checkout', '-q', '-b', 'side'])
      fs.writeFileSync(path.join(root, 'side.md'), 'clean\n')
      commitAll(root, 'side')
      git(root, ['checkout', '-q', 'main'])
      fs.writeFileSync(path.join(root, 'main.md'), 'clean\n')
      commitAll(root, 'main')
      git(root, ['merge', '-q', '--no-ff', '--no-commit', 'side'])
      fs.writeFileSync(path.join(root, 'resolution.md'), `host ${privateHost}\n`)
      const merge = commitAll(root, 'merge with resolution-only content')
      fs.rmSync(path.join(root, 'resolution.md'))
      const last = commitAll(root, 'delete the resolution')
      const rootOnly = scanHistory(`${first}^!`, root)
      assert.equal(rootOnly.scanned, 1)
      assert.ok(rootOnly.problems.some(problem => problem.includes('notes.md')))
      assert.deepEqual(scanHistory(`${first}..${second}`, root), {scanned: 0, problems: []})
      const mergeOnly = scanHistory(`${merge}^!`, root)
      assert.ok(mergeOnly.problems.some(problem => problem.includes('resolution.md')))
      assert.deepEqual(scanTree(root).problems, [])
      assert.ok(scanHistory(`${first}..${last}`, root).problems.some(problem => problem.includes('resolution.md')))
      assert.deepEqual(scanMessages(`${first}..${last}`, root).problems, [])
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('accepts a Dependabot bump commit message', () => {
    const message = [
      'Bump actions/checkout from 4.4.0 to 7.0.1',
      '',
      'Bumps [actions/checkout](https://github.com/actions/checkout) from 4.4.0 to 7.0.1.',
      '- [Release notes](https://github.com/actions/checkout/releases)',
      `- [Commits](https://github.com/actions/checkout/compare/${'1'.repeat(40)}...${'3'.repeat(40)})`,
      '',
      'Signed-off-by: dependabot[bot] <support@github.com>',
    ].join('\n')
    assert.deepEqual(scanContent('commit abc1234', message, {...config, secretPatternFiles: []}, secretPatterns), [])
  })

  it('flags an author or committer address outside the reviewed domains', () => {
    const root = temporaryRepo()
    try {
      fs.writeFileSync(path.join(root, 'a.md'), 'clean\n')
      git(root, ['add', '-A'])
      execFileSync('git', ['commit', '-q', '-m', 'by an outsider'], {cwd: root, env: {...process.env, GIT_AUTHOR_NAME: 'X', GIT_AUTHOR_EMAIL: concat('x@', companyHost('org')), GIT_COMMITTER_NAME: 'X', GIT_COMMITTER_EMAIL: concat('x@', companyHost('org'))}})
      const head = git(root, ['rev-parse', 'HEAD']).trim()
      assert.equal(scanMessages(`${head}^!`, root).problems.length, 2)
      assert.deepEqual(scanMessages(`${head}^!`, root, {identities: false}).problems, [])
      assert.equal(scanMessages(`${'0'.repeat(40)}..${head}`, root).scanned, 1)
      assert.equal(scanHistory(`${'f'.repeat(40)}..${head}`, root).scanned, 1)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('reports a symlink by its name and target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-link-'))
    try {
      fs.symlinkSync(`../${ticket('12345')}.md`, path.join(dir, 'link.md'))
      const target = fs.readlinkSync(path.join(dir, 'link.md'))
      assert.equal(findTrackerIds('docs/link.md', `symlink to ${target}`).length, 1)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})
