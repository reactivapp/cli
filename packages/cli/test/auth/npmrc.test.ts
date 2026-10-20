import {execFileSync} from 'node:child_process'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as ini from 'ini'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
  assertTokenSafe,
  BLOCK_END,
  BLOCK_START,
  installRoots,
  isConflictingLine,
  planNpmrc,
  removeManagedBlock,
  renderBlock,
  validateRegistryUrl,
  writeManagedBlocks,
} from '../../src/lib/auth/npmrc'
import {OTHER_TOKEN, REGISTRY_HOST, REGISTRY_URL, TOKEN, TOOLS_REGISTRY_URL} from '../helpers/fixtures'

const block = (token = TOKEN) =>
  renderBlock({token, expiresAt: '2026-10-01T18:04:11.000Z', registryUrl: REGISTRY_URL, toolsRegistryUrl: TOOLS_REGISTRY_URL})

const TEMPLATE_NPMRC = [
  `@reactivapp:registry=https://${REGISTRY_HOST}/npm/tools/`,
  `//${REGISTRY_HOST}/npm/tools/:_authToken=\${CODEARTIFACT_AUTH_TOKEN}`,
  `//${REGISTRY_HOST}/npm/submissions/:_authToken=\${CODEARTIFACT_AUTH_TOKEN}`,
  '',
].join('\n')

describe('renderBlock', () => {
  it('writes both scope mappings and both auth lines from the vended URLs, between the markers', () => {
    expect(block().split('\n')).toEqual([
      BLOCK_START,
      '# token expires 2026-10-01T18:04:11Z',
      `@reactivapp:registry=${TOOLS_REGISTRY_URL}`,
      `@reactiv-submissions:registry=${REGISTRY_URL}`,
      `//${REGISTRY_HOST}/npm/tools/:_authToken=${TOKEN}`,
      `//${REGISTRY_HOST}/npm/submissions-acme/:_authToken=${TOKEN}`,
      'legacy-peer-deps=true',
      BLOCK_END,
    ])
    expect(BLOCK_START).toBe('# >>> reactiv (managed — do not edit; run `reactiv login` to refresh) >>>')
  })

  it('refuses an expiry that could inject lines', () => {
    expect(() =>
      renderBlock({token: TOKEN, expiresAt: 'soon\n//evil/:_authToken=x', registryUrl: REGISTRY_URL, toolsRegistryUrl: TOOLS_REGISTRY_URL}),
    ).toThrow('unreadable token expiry')
  })
})

describe('validateRegistryUrl', () => {
  it('accepts https npm endpoints of the vended-registry host shape', () => {
    expect(validateRegistryUrl(REGISTRY_URL)).toBe(REGISTRY_URL)
    expect(validateRegistryUrl(TOOLS_REGISTRY_URL)).toBe(TOOLS_REGISTRY_URL)
  })

  it.each([
    ['plain http', REGISTRY_URL.replace('https:', 'http:')],
    ['public npm', 'https://registry.npmjs.org/'],
    ['a look-alike host', `https://${REGISTRY_HOST}.evil.test/npm/x/`],
    ['embedded credentials', `https://user:pw@${REGISTRY_HOST}/npm/x/`],
    ['a query string', `${REGISTRY_URL}?a=1`],
    ['an empty query', `${REGISTRY_URL}?`],
    ['a fragment', `${REGISTRY_URL}#x`],
    ['an explicit port', `https://${REGISTRY_HOST}:8443/npm/x/`],
    ['no trailing slash', REGISTRY_URL.slice(0, -1)],
    ['not a string', 42],
  ])('rejects %s', (_, url) => {
    expect(() => validateRegistryUrl(url)).toThrow('vending API returned a registry URL outside CodeArtifact — nothing written')
  })
})

describe('assertTokenSafe', () => {
  it.each(['$', '{', '}', ';', '#', '\n', '\r'])('refuses a token containing %j', char => {
    expect(() => assertTokenSafe(`abc${char}def`)).toThrow("npm's ini format cannot carry safely")
  })

  it.each([' abc', 'abc ', '"abc"', "'abc'", ''])('refuses %j (trimmed, unquoted or empty)', token => {
    expect(() => assertTokenSafe(token)).toThrow("npm's ini format cannot carry safely")
  })

  it('accepts characters outside the denylist such as = / +', () => {
    expect(assertTokenSafe('a=b/c+d.e_f-g')).toBe('a=b/c+d.e_f-g')
    expect(assertTokenSafe('"abc')).toBe('"abc')
  })

  it("round-trips through npm's own ini parser byte for byte", () => {
    for (const token of [TOKEN, 'a=b/c+d', 'eyJ2ZXIiOjF9.payload-with_dots.and=padding==']) {
      const parsed = ini.parse(planNpmrc('', block(token), '.npmrc').content) as Record<string, string>
      expect(parsed[`//${REGISTRY_HOST}/npm/tools/:_authToken`]).toBe(token)
      expect(parsed[`//${REGISTRY_HOST}/npm/submissions-acme/:_authToken`]).toBe(token)
      expect(parsed['@reactiv-submissions:registry']).toBe(REGISTRY_URL)
    }
  })
})

describe('conflict rule', () => {
  it('removes scope mappings and vended-registry-host auth lines, nothing else', () => {
    expect(isConflictingLine('@reactivapp:registry=https://example.test/')).toBe(true)
    expect(isConflictingLine(' @reactiv-submissions:registry = https://registry.npmjs.org/')).toBe(true)
    expect(isConflictingLine(`//${REGISTRY_HOST}/npm/old-repo/:_authToken=stale`)).toBe(true)
    expect(isConflictingLine('//other-000000000000.d.codeartifact.eu-west-1.amazonaws.com/npm/x/:_authToken=stale')).toBe(true)
    expect(isConflictingLine('//registry.npmjs.org/:_authToken=npm-token')).toBe(false)
    expect(isConflictingLine('//registry.example.test/:_authToken=gh-token')).toBe(false)
    expect(isConflictingLine('@other:registry=https://example.test/')).toBe(false)
    expect(isConflictingLine('# @reactivapp:registry=commented')).toBe(false)
    expect(isConflictingLine('save-exact=true')).toBe(false)
  })

  it("strips all three of the template's placeholder lines on first write", () => {
    const {content, removedConflicts} = planNpmrc(TEMPLATE_NPMRC, block(), '.npmrc')
    expect(removedConflicts).toBe(3)
    expect(content).not.toContain('CODEARTIFACT_AUTH_TOKEN')
    expect(content).not.toContain('/npm/submissions/:')
    expect(content).toBe(`${block()}\n`)
  })

  it("keeps the developer's lines byte for byte", () => {
    const developer = 'save-exact=true\r\n//registry.npmjs.org/:_authToken=npm-own\n; a comment\n\nengine-strict=true'
    const {content} = planNpmrc(developer, block(), '.npmrc')
    expect(content).toBe(`${developer}\n${block()}\n`)
  })
})

describe('marker pairs', () => {
  it('collapses several complete blocks into exactly one', () => {
    const doubled = `a=1\n${block(OTHER_TOKEN)}\nb=2\n${block(OTHER_TOKEN)}\n`
    const {content} = planNpmrc(doubled, block(), '.npmrc')
    expect(content).toBe(`a=1\nb=2\n${block()}\n`)
    expect(content.split(BLOCK_START)).toHaveLength(2)
  })

  it('refuses a lone opening marker, naming its line, instead of deleting to end of file', () => {
    expect(() => planNpmrc(`a=1\n${BLOCK_START}\nmine=keep\n`, block(), '/p/.npmrc')).toThrow('/p/.npmrc line 2 has a reactiv marker without its partner')
  })

  it('refuses a lone closing marker', () => {
    expect(() => planNpmrc(`a=1\nb=2\n${BLOCK_END}\n`, block(), '/p/.npmrc')).toThrow('line 3')
  })

  it('refuses an opening marker followed by another opening marker', () => {
    expect(() => planNpmrc(`${BLOCK_START}\n${BLOCK_START}\nx\n${BLOCK_END}\n`, block(), '/p/.npmrc')).toThrow('line 1')
  })
})

describe('writeManagedBlocks', () => {
  let dir: string
  const logs: string[] = []
  const options = {log: (message: string) => logs.push(message), ignoreState: () => 'no-repository' as const}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'npmrc-'))
    logs.length = 0
  })
  afterEach(() => rmSync(dir, {recursive: true, force: true}))

  it('creates the file with mode 0600', () => {
    expect(writeManagedBlocks([dir], block(), options)).toEqual([join(dir, '.npmrc')])
    expect(statSync(join(dir, '.npmrc')).mode & 0o777).toBe(0o600)
  })

  it('is idempotent: the same token leaves the file and its mtime untouched', () => {
    writeManagedBlocks([dir], block(), options)
    const file = join(dir, '.npmrc')
    const before = readFileSync(file, 'utf8')
    utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
    expect(writeManagedBlocks([dir], block(), options)).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(statSync(file).mtime.toISOString()).toBe('2020-01-01T00:00:00.000Z')
  })

  it('makes an existing readable file private before the token goes in, and says so', () => {
    const file = join(dir, '.npmrc')
    writeFileSync(file, TEMPLATE_NPMRC, {mode: 0o644})
    chmodSync(file, 0o644)
    writeManagedBlocks([dir], block(), options)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(logs.some(line => line.includes('private (mode 0600)'))).toBe(true)
    expect(logs.some(line => line.includes('Removed 3 conflicting registry line(s)'))).toBe(true)
    expect(logs.join('\n')).not.toContain('CODEARTIFACT_AUTH_TOKEN')
  })

  it('refuses to write when the file cannot be made private', () => {
    const file = join(dir, '.npmrc')
    writeFileSync(file, 'a=1\n', {mode: 0o644})
    chmodSync(file, 0o644)
    const chmod = () => {
      throw new Error('EPERM')
    }
    expect(() => writeManagedBlocks([dir], block(), {...options, chmod})).toThrow(
      'could not make `.npmrc` private (0600); refusing to write a token into a readable file',
    )
    expect(readFileSync(file, 'utf8')).toBe('a=1\n')
  })

  it('refuses a symlinked .npmrc, naming the target', () => {
    writeFileSync(join(dir, 'shared-npmrc'), 'a=1\n')
    symlinkSync(join(dir, 'shared-npmrc'), join(dir, '.npmrc'))
    expect(() => writeManagedBlocks([dir], block(), options)).toThrow(`symlink to ${join(dir, 'shared-npmrc')}`)
    expect(readFileSync(join(dir, 'shared-npmrc'), 'utf8')).toBe('a=1\n')
  })

  it('refuses a .npmrc tracked by git, even when .gitignore lists it', () => {
    execFileSync('git', ['init', '--quiet'], {cwd: dir})
    writeFileSync(join(dir, '.npmrc'), 'a=1\n')
    execFileSync('git', ['add', '.npmrc'], {cwd: dir})
    writeFileSync(join(dir, '.gitignore'), '.npmrc\n')
    expect(() => writeManagedBlocks([dir], block(), {log: options.log})).toThrow('is not ignored by git; add `.npmrc` to .gitignore (and `git rm --cached .npmrc` if it is tracked)')
    expect(readFileSync(join(dir, '.npmrc'), 'utf8')).toBe('a=1\n')
  })

  it('refuses an untracked .npmrc that git would not ignore', () => {
    execFileSync('git', ['init', '--quiet'], {cwd: dir})
    expect(() => writeManagedBlocks([dir], block(), {log: options.log})).toThrow('is not ignored by git')
    expect(existsSync(join(dir, '.npmrc'))).toBe(false)
  })

  it('writes an ignored .npmrc inside a git work tree', () => {
    execFileSync('git', ['init', '--quiet'], {cwd: dir})
    writeFileSync(join(dir, '.gitignore'), '.npmrc\n')
    expect(writeManagedBlocks([dir], block(), {log: options.log})).toHaveLength(1)
  })

  it('refuses when git fails for any reason other than a missing repository', () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/worktree\n')
    expect(() => writeManagedBlocks([dir], block(), {log: options.log})).toThrow('could not ask git whether')
    expect(existsSync(join(dir, '.npmrc'))).toBe(false)
  })

  it('ignores GIT_DIR from the environment when asking git', () => {
    const other = mkdtempSync(join(tmpdir(), 'other-repo-'))
    execFileSync('git', ['init', '--quiet'], {cwd: other})
    writeFileSync(join(other, '.gitignore'), '.npmrc\n')
    execFileSync('git', ['init', '--quiet'], {cwd: dir})
    const saved = process.env.GIT_DIR
    process.env.GIT_DIR = join(other, '.git')
    try {
      expect(() => writeManagedBlocks([dir], block(), {log: options.log})).toThrow('is not ignored by git')
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
      rmSync(other, {recursive: true, force: true})
    }
  })

  it('ignores GIT_CEILING_DIRECTORIES when the .npmrc sits below the repository root', () => {
    execFileSync('git', ['init', '--quiet'], {cwd: dir})
    const app = join(dir, 'app')
    mkdirSync(app)
    const saved = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = dir
    try {
      expect(() => writeManagedBlocks([app], block(), {log: options.log})).toThrow('is not ignored by git')
      expect(existsSync(join(app, '.npmrc'))).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = saved
    }
  })

  it('writes outside a git work tree', () => {
    expect(writeManagedBlocks([dir], block(), {log: options.log})).toHaveLength(1)
  })

  it('checks every install root before writing any, so one refusal leaves all untouched', () => {
    const app = join(dir, 'app')
    mkdirSync(app)
    writeFileSync(join(app, '.npmrc'), `${BLOCK_START}\n`)
    expect(() => writeManagedBlocks([dir, app], block(), options)).toThrow('without its partner')
    expect(existsSync(join(dir, '.npmrc'))).toBe(false)
  })

  it('writes the same block into both install roots of a library-first project', () => {
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'app'))
    writeFileSync(join(dir, 'app', 'package.json'), '{}')
    mkdirSync(join(dir, 'unrelated'))
    writeFileSync(join(dir, 'unrelated', 'package.json'), '{}')
    const roots = installRoots(dir)
    expect(roots).toEqual([dir, join(dir, 'app')])
    writeManagedBlocks(roots, block(), options)
    expect(readFileSync(join(dir, '.npmrc'), 'utf8')).toBe(readFileSync(join(dir, 'app', '.npmrc'), 'utf8'))
    expect(existsSync(join(dir, 'unrelated', '.npmrc'))).toBe(false)
  })

  it('only the root counts when app/ is not an npm project', () => {
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'app'))
    expect(installRoots(dir)).toEqual([dir])
  })
})

describe('removeManagedBlock', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'npmrc-rm-'))
  })
  afterEach(() => rmSync(dir, {recursive: true, force: true}))

  it("removes only the block and keeps the developer's lines", () => {
    const file = join(dir, '.npmrc')
    writeFileSync(file, `save-exact=true\n${block()}\n`)
    expect(removeManagedBlock(file, () => undefined)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('save-exact=true\n')
  })

  it('leaves a file with a stray marker alone and warns', () => {
    const file = join(dir, '.npmrc')
    writeFileSync(file, `${BLOCK_START}\nmine=1\n`)
    const warnings: string[] = []
    expect(removeManagedBlock(file, message => warnings.push(message))).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(`${BLOCK_START}\nmine=1\n`)
    expect(warnings[0]).toContain('without its partner')
  })
})
