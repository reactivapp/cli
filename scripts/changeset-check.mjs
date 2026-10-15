#!/usr/bin/env node
// Pull request gate for release intent. Every change to a published package
// must be covered by a changeset naming that package, except for the version
// pull request changesets itself produces, which only bumps versions, writes
// changelogs and consumes changeset files.
//
// Usage: node scripts/changeset-check.mjs --since <base commit> [--root <dir>]

import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const run = (root, command, args) => execFileSync(command, args, {cwd: root, encoding: 'utf8'})

/** `git diff --name-status -z` records: renames and copies carry their source too. */
export const parseNameStatus = output => {
  const fields = output.split('\0').filter(Boolean)
  const entries = []
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index]
    if (status.startsWith('R') || status.startsWith('C')) {
      entries.push({status: status[0], file: fields[index + 2], source: fields[index + 1]})
      index += 2
    } else {
      entries.push({status: status[0], file: fields[index + 1]})
      index += 1
    }
  }
  return entries
}

export const packageOf = file => {
  const match = /^packages\/([^/]+)\//.exec(file)
  return match ? `packages/${match[1]}` : undefined
}

const MANIFEST = /^packages\/[^/]+\/package\.json$/
const CHANGELOG = /^packages\/[^/]+\/CHANGELOG\.md$/
const CHANGESET = /^\.changeset\/(?!README\.md$).+\.md$/

const withoutVersions = manifest => {
  const {version: _version, ...rest} = manifest
  return JSON.stringify(rest)
}

/**
 * The version pull request: at least one consumed changeset, and every manifest
 * edit changes the version field only (workspace ranges stay as they are).
 */
export const isVersionPullRequest = (entries, readOld, readNew) => {
  if (entries.length === 0) return false
  if (!entries.some(entry => CHANGESET.test(entry.file) && entry.status === 'D')) return false
  for (const entry of entries) {
    if (CHANGELOG.test(entry.file) && entry.status === 'M') continue
    if (CHANGESET.test(entry.file) && entry.status === 'D') continue
    if (MANIFEST.test(entry.file) && entry.status === 'M') {
      let before
      let after
      try {
        before = JSON.parse(readOld(entry.file))
        after = JSON.parse(readNew(entry.file))
      } catch {
        return false
      }
      if (before.version === after.version || withoutVersions(before) !== withoutVersions(after)) return false
      continue
    }
    return false
  }
  return true
}

// Tests, READMEs and changelogs do not change what the package does.
const affectsPublished = file => packageOf(file) !== undefined && !/^packages\/[^/]+\/(test\/|README\.md$|CHANGELOG\.md$)/.test(file)

/** Packages whose published content a change touches; a rename counts for the package it leaves too. */
export const changedPackageDirs = entries => {
  const dirs = new Set()
  for (const entry of entries) {
    if (affectsPublished(entry.file)) dirs.add(packageOf(entry.file))
    if (entry.status === 'R' && entry.source && affectsPublished(entry.source)) dirs.add(packageOf(entry.source))
  }
  return [...dirs]
}

export const check = ({base, root = scriptRoot}) => {
  // The diff and the old manifests both come from the merge base, so a main
  // that moved after the branch was cut does not show up as a change.
  const mergeBase = run(root, 'git', ['merge-base', base, 'HEAD']).trim()
  const entries = parseNameStatus(run(root, 'git', ['diff', '--name-status', '-z', `${mergeBase}..HEAD`]))
  const readOld = file => run(root, 'git', ['show', `${mergeBase}:${file}`])
  const readNew = file => fs.readFileSync(path.join(root, file), 'utf8')
  if (isVersionPullRequest(entries, readOld, readNew)) {
    return {ok: true, message: 'CHANGESET CHECK PASSED — version pull request: versions bumped, changelogs written, changesets consumed'}
  }
  const changedPackages = changedPackageDirs(entries)
    .filter(dir => fs.existsSync(path.join(root, dir, 'package.json')))
    .map(dir => JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')).name)
  if (changedPackages.length === 0) return {ok: true, message: 'CHANGESET CHECK PASSED — no published package changed'}
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'changeset-status-')), 'status.json')
  try {
    run(root, 'pnpm', ['changeset', 'status', `--since=${mergeBase}`, `--output=${output}`])
  } catch (error) {
    return {ok: false, message: `${error.stdout ?? ''}\nCHANGESET CHECK FAILED — changeset status reported changed packages without a changeset`}
  }
  const planned = new Set(JSON.parse(fs.readFileSync(output, 'utf8')).releases.map(release => release.name))
  const uncovered = changedPackages.filter(name => !planned.has(name))
  if (uncovered.length > 0) return {ok: false, message: `CHANGESET CHECK FAILED — changed without a changeset naming them: ${uncovered.join(', ')} (run pnpm changeset)`}
  return {ok: true, message: `CHANGESET CHECK PASSED — ${changedPackages.join(', ')} covered by the pending changesets`}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = flag => {
    const index = process.argv.indexOf(flag)
    return index === -1 ? undefined : process.argv[index + 1]
  }
  const base = option('--since')
  if (!base) {
    console.error('--since needs the base commit of the pull request')
    process.exit(2)
  }
  const result = check({base, root: option('--root') ? path.resolve(option('--root')) : scriptRoot})
  ;(result.ok ? console.log : console.error)(result.message)
  process.exit(result.ok ? 0 : 1)
}
