#!/usr/bin/env node
// Repository-wide scan for anything that belongs to Reactiv's internal
// infrastructure rather than to this public CLI: credential values (also
// base64-encoded or split across string constants), account ids and ARNs,
// internal hostnames and registry markers, hostnames, repository links and
// email addresses outside the reviewed allowlists, and work-tracker ids.
//
// Usage:
//   node scripts/internal-reference-scan.mjs                      every tracked and untracked file, names and symlink targets included
//   node scripts/internal-reference-scan.mjs --messages <range>   the commit messages, authors and committers in a git range
//                                            (--bodies-only skips the author and committer check: forge-made merge and squash commits carry the forge's identities)
//   node scripts/internal-reference-scan.mjs --history <range>    every file version each commit in a git range introduced, merges and root commits included
//
// Legitimate mentions are listed, with a reason each, in
// scripts/internal-reference-allowlist.json. Credential-shaped text is
// redacted from every diagnostic before it is printed.

import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

import {decodeContent, FICTIONAL_HOST, redactProblems, scanContent, scanPath} from './lib/internal-reference-rules.mjs'
import {compileSecretPatterns} from './lib/pack-rules.mjs'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const loadConfig = () => JSON.parse(fs.readFileSync(path.join(scriptRoot, 'scripts/internal-reference-allowlist.json'), 'utf8'))

const loadSecretPatterns = () => compileSecretPatterns(fs.readFileSync(path.join(scriptRoot, 'scripts/secret-patterns.ere'), 'utf8'))

const git = (root, args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024})
const gitBuffer = (root, args) => execFileSync('git', args, {cwd: root, maxBuffer: 256 * 1024 * 1024})

export const listFiles = (root = scriptRoot) =>
  git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean)
    .filter(file => {
      try {
        const stat = fs.lstatSync(path.join(root, file))
        return stat.isFile() || stat.isSymbolicLink()
      } catch {
        return false
      }
    })

// Rules see the repository path (the allowlists are keyed on it); the label
// only prefixes the diagnostic, and every diagnostic is redacted.
const scanEntry = (label, file, content, config, secretPatterns) =>
  redactProblems([...scanPath(file, config, secretPatterns), ...scanContent(file, content, config, secretPatterns)], secretPatterns).map(problem => `${label}${problem}`)

export const scanTree = (root = scriptRoot) => {
  const config = loadConfig()
  const secretPatterns = loadSecretPatterns()
  const problems = []
  let scanned = 0
  for (const file of listFiles(root)) {
    scanned += 1
    const absolute = path.join(root, file)
    const content = fs.lstatSync(absolute).isSymbolicLink() ? `symlink to ${fs.readlinkSync(absolute)}` : decodeContent(fs.readFileSync(absolute))
    problems.push(...scanEntry('', file, content, config, secretPatterns))
  }
  return {scanned, problems}
}

// A push event names the previous tip as the range start; on a new branch that
// is all zeros, and after a force-push it may be gone. The tip alone is then
// the whole range we can scan.
const resolveRange = (root, range) => {
  const match = /^([0-9a-f]{7,40})\.\.(\S+)$/i.exec(range)
  if (!match) return range
  const [, before, after] = match
  if (/^0+$/.test(before)) return `${after}^!`
  try {
    git(root, ['cat-file', '-e', `${before}^{commit}`])
    return range
  } catch {
    return `${after}^!`
  }
}

const commitsIn = (root, range) => git(root, ['rev-list', '--reverse', resolveRange(root, range)]).split('\n').filter(Boolean)

/** Commit messages, author and committer addresses in a range; the pattern-file exemption does not apply. */
export const scanMessages = (range, root = scriptRoot, options = {identities: true}) => {
  const config = loadConfig()
  const secretPatterns = loadSecretPatterns()
  const allowedAddresses = new Set(config.allowedEmails.map(entry => entry.address.toLowerCase()))
  const allowedDomains = new Set(config.allowedAuthorDomains.map(entry => entry.domain.toLowerCase()))
  const problems = []
  const commits = commitsIn(root, range)
  for (const hash of commits) {
    const label = `commit ${hash.slice(0, 7)}`
    const [authorEmail, committerEmail, body] = git(root, ['log', '-1', '--format=%ae%x00%ce%x00%B', hash]).split('\0')
    problems.push(...redactProblems(scanContent(label, body ?? '', {...config, secretPatternFiles: []}, secretPatterns), secretPatterns))
    if (!options.identities) continue
    for (const [role, address] of [['author', authorEmail], ['committer', committerEmail]]) {
      const domain = address.toLowerCase().split('@')[1] ?? ''
      if (allowedAddresses.has(address.toLowerCase()) || allowedDomains.has(domain) || FICTIONAL_HOST.test(domain)) continue
      problems.push(`${label}: ${role} address on ${domain || '(no domain)'} is not in allowedEmails or allowedAuthorDomains`)
    }
  }
  return {scanned: commits.length, problems}
}

/** Every file version (and path) a commit in the range introduced against any of its parents; root commits and merges included. */
export const scanHistory = (range, root = scriptRoot) => {
  const config = loadConfig()
  const secretPatterns = loadSecretPatterns()
  const problems = []
  let scanned = 0
  for (const hash of commitsIn(root, range)) {
    const entries = new Set(git(root, ['diff-tree', '--no-commit-id', '-r', '-m', '--root', '-z', '--diff-filter=AMCRT', '--name-only', hash]).split('\0').filter(Boolean))
    for (const file of entries) {
      const tree = git(root, ['ls-tree', '-z', hash, '--', file]).split('\0')[0]
      if (!tree) continue
      scanned += 1
      const mode = tree.split(/\s+/)[0]
      const blob = gitBuffer(root, ['show', `${hash}:${file}`])
      const content = mode === '120000' ? `symlink to ${blob.toString('utf8')}` : decodeContent(blob)
      problems.push(...scanEntry(`${hash.slice(0, 7)}:`, file, content, config, secretPatterns))
    }
  }
  return {scanned, problems}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = ['--messages', '--history'].find(flag => process.argv.includes(flag))
  const range = mode ? process.argv[process.argv.indexOf(mode) + 1] : undefined
  if (mode && !range) {
    console.error(`${mode} needs a git range`)
    process.exit(2)
  }
  const result = mode === '--messages' ? scanMessages(range, scriptRoot, {identities: !process.argv.includes('--bodies-only')}) : mode === '--history' ? scanHistory(range) : scanTree()
  const unit = mode === '--messages' ? 'commits' : mode === '--history' ? 'historical file versions' : 'files'
  if (result.problems.length > 0) {
    console.error(`INTERNAL REFERENCE SCAN FAILED (${result.problems.length} problem${result.problems.length === 1 ? '' : 's'} in ${result.scanned} ${unit}):`)
    for (const problem of result.problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log(`INTERNAL REFERENCE SCAN PASSED — ${result.scanned} ${unit} hold no credentials, account ids, internal hosts, unreviewed links or addresses, or tracker ids`)
}
