import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {changedPackageDirs, isVersionPullRequest, parseNameStatus} from '../changeset-check.mjs'

const record = (...fields) => `${fields.join('\0')}\0`

describe('name-status parsing', () => {
  it('keeps both ends of a rename or copy', () => {
    const entries = parseNameStatus(record('M', 'README.md') + record('R100', 'packages/cli/src/index.ts', 'docs/index-example.ts') + record('C75', 'a.md', 'b.md'))
    assert.deepEqual(entries, [
      {status: 'M', file: 'README.md'},
      {status: 'R', file: 'docs/index-example.ts', source: 'packages/cli/src/index.ts'},
      {status: 'C', file: 'b.md', source: 'a.md'},
    ])
  })
})

describe('changed packages', () => {
  it('counts the package a published file leaves, ignores tests, READMEs and changelogs', () => {
    const entries = parseNameStatus(
      record('R100', 'packages/cli/src/index.ts', 'docs/index-example.ts') +
        record('M', 'packages/cli-ui/test/banner.test.ts') +
        record('M', 'packages/cli-ui/README.md') +
        record('M', 'packages/cli/CHANGELOG.md'),
    )
    assert.deepEqual(changedPackageDirs(entries), ['packages/cli'])
    assert.deepEqual(changedPackageDirs(parseNameStatus(record('M', 'packages/cli-ui/src/tokens.ts'))), ['packages/cli-ui'])
  })
})

describe('version pull request shape', () => {
  const manifest = (version, extra = {}) => JSON.stringify({name: '@reactivapp/cli', version, dependencies: {'@reactivapp/cli-ui': 'workspace:*'}, ...extra})
  const bump = parseNameStatus(record('M', 'packages/cli/package.json') + record('M', 'packages/cli/CHANGELOG.md') + record('D', '.changeset/public-repository.md'))

  it('accepts a version bump that consumes a changeset and changes nothing else in the manifest', () => {
    assert.equal(isVersionPullRequest(bump, () => manifest('0.6.0'), () => manifest('0.6.1')), true)
  })

  it('rejects a manifest edit that is not a version change, or one without a consumed changeset', () => {
    assert.equal(isVersionPullRequest(bump, () => manifest('0.6.0'), () => manifest('0.6.0', {dependencies: {left: '1.0.0'}})), false)
    assert.equal(isVersionPullRequest(bump, () => manifest('0.6.0'), () => manifest('0.6.1', {bin: {other: './x'}})), false)
    const noChangeset = parseNameStatus(record('M', 'packages/cli/package.json'))
    assert.equal(isVersionPullRequest(noChangeset, () => manifest('0.6.0'), () => manifest('0.6.1')), false)
  })

  it('rejects any other file in the diff', () => {
    const withSource = parseNameStatus(record('M', 'packages/cli/package.json') + record('D', '.changeset/x.md') + record('M', 'packages/cli/src/index.ts'))
    assert.equal(isVersionPullRequest(withSource, () => manifest('0.6.0'), () => manifest('0.6.1')), false)
  })
})
