#!/usr/bin/env node
// Pre-publish gate for the public CLI packages. For each package listed in
// scripts/pack-allowlist.json it packs a real tarball with pnpm (the same
// packer the release uses, so workspace:* ranges are rewritten), then fails if
// the tarball holds anything outside the files whitelist, a secret-pattern
// match, or a hostname that is not on the allowed list.
//
// Usage: node scripts/pack-inspect.mjs [--out <dir>]
// With --out, the inspected tarballs and a SHA256SUMS file are left in <dir>
// so a release job can publish exactly these bytes.

import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

import {
  checkPackedManifest,
  compileSecretPatterns,
  findDisallowedEntries,
  findEndpointProblems,
  findSecrets,
} from './lib/pack-rules.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/pack-allowlist.json'), 'utf8'))
const secretPatterns = compileSecretPatterns(fs.readFileSync(path.join(repoRoot, 'scripts/secret-patterns.ere'), 'utf8'))

const outFlag = process.argv.indexOf('--out')
if (outFlag !== -1 && !process.argv[outFlag + 1]) {
  console.error('--out needs a directory')
  process.exit(2)
}
const outDir = outFlag === -1 ? fs.mkdtempSync(path.join(os.tmpdir(), 'pack-inspect-')) : path.resolve(process.argv[outFlag + 1])
fs.mkdirSync(outDir, {recursive: true})

const run = (command, args, cwd) => execFileSync(command, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']})

// `tar -tvzf` prints a mode string first; its first character is the entry type.
const TYPE_BY_MODE_CHAR = {'-': 'file', d: 'directory', l: 'symlink', h: 'hardlink'}

const listEntries = tarball => {
  const names = run('tar', ['-tzf', tarball]).split('\n').filter(Boolean)
  const modes = run('tar', ['-tvzf', tarball]).split('\n').filter(Boolean).map(line => line[0])
  if (names.length !== modes.length) throw new Error(`could not read entry types from ${tarball}`)
  return names.map((name, index) => ({path: name, type: TYPE_BY_MODE_CHAR[modes[index]] ?? `type "${modes[index]}"`}))
}

const walkFiles = dir =>
  fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walkFiles(full) : [full]
  })

const sums = []
const failures = []

for (const [packageDir, expected] of Object.entries(config.packages)) {
  const absoluteDir = path.join(repoRoot, packageDir)
  const parsed = JSON.parse(run('pnpm', ['pack', '--json', '--pack-destination', outDir], absoluteDir))
  const packed = Array.isArray(parsed) ? parsed[0] : parsed
  const tarball = packed.filename
  const entries = listEntries(tarball)

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-inspect-extract-'))
  const problems = []
  try {
    problems.push(...findDisallowedEntries(entries, expected.entries))
    // Extract only when the entry list is clean: a link or traversal entry
    // must never be written to disk.
    if (problems.length === 0) {
      run('tar', ['-xzf', tarball, '-C', extractDir])
      const manifest = JSON.parse(fs.readFileSync(path.join(extractDir, 'package/package.json'), 'utf8'))
      problems.push(...checkPackedManifest(manifest, expected, entries.map(entry => entry.path)))
      for (const file of walkFiles(extractDir)) {
        const relative = path.relative(extractDir, file)
        const content = fs.readFileSync(file, 'utf8')
        problems.push(...findSecrets(relative, content, secretPatterns))
        problems.push(...findEndpointProblems(relative, content, config.allowedHosts, config.allowedLiterals))
      }
    }
  } finally {
    fs.rmSync(extractDir, {recursive: true, force: true})
  }

  const sha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex')
  console.log(`\n${expected.name}@${packed.version} — ${path.basename(tarball)}`)
  console.log(`sha256 ${sha256}`)
  for (const entry of entries) console.log(`  ${entry.path}`)

  if (problems.length > 0) {
    failures.push(...problems.map(problem => `${expected.name}: ${problem}`))
  } else {
    sums.push(`${sha256}  ${path.basename(tarball)}`)
  }
}

if (failures.length > 0) {
  console.error(`\nPACK INSPECTION FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'}):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

if (outFlag === -1) {
  fs.rmSync(outDir, {recursive: true, force: true})
  console.log(`\nPACK INSPECTION PASSED — whitelist, secret scan and endpoint allowlist clean for ${sums.length} package(s)`)
} else {
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`)
  console.log(`\nPACK INSPECTION PASSED — whitelist, secret scan and endpoint allowlist clean for ${sums.length} package(s); tarballs in ${outDir}`)
}
