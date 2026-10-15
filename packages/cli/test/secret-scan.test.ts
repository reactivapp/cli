import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
  createSecretScanner,
  findSecretsInDirectory,
  formatSecretFindings,
  MAX_MATCH_LENGTH,
  SECRET_PATTERNS,
  type SecretFinding,
  WITHHELD_NAME,
} from '../src/lib/secret-scan.js'

// Samples are assembled at runtime from obviously fake filler so no
// credential-shaped literal ever sits in this file or its history.
const underscore = '_'
const SECRET_SAMPLES: Record<string, string> = {
  'aws-access-key-id': `${'AKIA'}${'Q'.repeat(16)}`,
  'aws-secret-access-key': `${['aws', 'secret', 'access', 'key'].join(underscore)} = ${'Q7'.repeat(20)}`,
  'github-token': `${'gh'}p_${'a'.repeat(36)}`,
  'github-fine-grained-token': `${['github', 'pat'].join(underscore)}_${'b'.repeat(30)}`,
  'npm-token': `${'npm'}_${'c'.repeat(36)}`,
  'pem-private-key': `${'-'.repeat(5)}BEGIN RSA PRIVATE KEY${'-'.repeat(5)}`,
  'reactiv-api-key': `${'rpk'}_${'0'.repeat(26)}_${'x'.repeat(8)}`,
  'shopify-access-token': `${'shp'}at_${'f'.repeat(32)}`,
}

const CLEAN_LOOKALIKES = [
  `const short = '${'AKIA'}${'Q'.repeat(15)}'`,
  `const lower = '${'akia'}${'q'.repeat(16)}'`,
  `const ghShort = '${'gh'}p_${'a'.repeat(35)}'`,
  `const npmDir = '${'npm'}_modules'`,
  `const npmShort = '${'npm'}_${'c'.repeat(35)}'`,
  `${'-'.repeat(5)}BEGIN CERTIFICATE${'-'.repeat(5)}`,
  `${'-'.repeat(5)}BEGIN PUBLIC KEY${'-'.repeat(5)}`,
  `const keyIdOnly = '${'rpk'}_${'0'.repeat(26)}'`,
  `const lowerUlid = '${'rpk'}_${'a'.repeat(26)}_'`,
  `const githubPage = 'github_page'`,
  `const fineGrainedPrefixOnly = '${['github', 'pat'].join('_')}_ is the prefix'`,
  `const fineGrainedShort = '${['github', 'pat'].join('_')}_${'b'.repeat(21)}'`,
  `const fineGrainedUnderscores = '${['github', 'pat'].join('_')}_${'_'.repeat(22)}'`,
  `const awsRegion = 'us-east-1'`,
].join('\n')

const scanText = (text: string, chunkSize = text.length || 1): SecretFinding[] => {
  const scanner = createSecretScanner('sample.ts')
  const bytes = Buffer.from(text, 'latin1')
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    scanner.push(bytes.subarray(offset, offset + chunkSize))
  }
  return scanner.end()
}

describe('secret patterns', () => {
  it('has a sample for every pattern class', () => {
    expect(Object.keys(SECRET_SAMPLES).sort()).toEqual(SECRET_PATTERNS.map(p => p.id).sort())
  })

  it('detects every Shopify access token prefix, and only a full-length token', () => {
    for (const prefix of ['at', 'ca', 'pa', 'ss']) {
      const token = `${'shp'}${prefix}_${'f'.repeat(32)}`
      expect(scanText(`const t = '${token}'\n`)).toEqual([{file: 'sample.ts', line: 1, pattern: 'shopify-access-token'}])
    }
    expect(scanText(`const t = '${'shp'}at_${'f'.repeat(31)}'\n`)).toEqual([])
    expect(scanText(`const t = '${'shp'}xx_${'f'.repeat(32)}'\n`)).toEqual([])
  })

  for (const [id, sample] of Object.entries(SECRET_SAMPLES)) {
    it(`detects ${id} with its line number`, () => {
      const findings = scanText(`// header\nconst a = 1\nconst value = '${sample}'\n`)
      expect(findings).toEqual([{file: 'sample.ts', line: 3, pattern: id}])
    })

    it(`detects ${id} split across chunks at every offset`, () => {
      const text = `x\n  ${sample}  \n`
      for (let split = 1; split < text.length; split += 1) {
        const scanner = createSecretScanner('sample.ts')
        scanner.push(Buffer.from(text.slice(0, split), 'latin1'))
        scanner.push(Buffer.from(text.slice(split), 'latin1'))
        expect(scanner.end(), `split at ${split}`).toEqual([{file: 'sample.ts', line: 2, pattern: id}])
      }
    })

    it(`detects ${id} inside an overlong line wherever the carry is trimmed`, () => {
      for (const lead of [8 * 1024 - sample.length, 8 * 1024 - 3, 8 * 1024, 20_000, 70_000]) {
        const text = `${'a'.repeat(lead)}${sample}${'a'.repeat(9000)}`
        for (const chunkSize of [1000, 4096, 16 * 1024]) {
          expect(scanText(text, chunkSize), `lead ${lead}, chunk ${chunkSize}`).toEqual([
            {file: 'sample.ts', line: 1, pattern: id},
          ])
        }
      }
    })

    it(`detects ${id} in binary content`, () => {
      const bytes = Buffer.concat([Buffer.from([0, 255, 128, 10, 0, 7]), Buffer.from(sample, 'latin1'), Buffer.from([0, 200])])
      const scanner = createSecretScanner('asset.bin')
      scanner.push(bytes)
      expect(scanner.end()).toEqual([{file: 'asset.bin', line: 2, pattern: id}])
    })
  }

  it('keeps every pattern within the documented match length', () => {
    for (const sample of Object.values(SECRET_SAMPLES)) expect(sample.length).toBeLessThan(MAX_MATCH_LENGTH)
    const longestPem = `${'-'.repeat(5)}BEGIN ${'ABCDEFGHIJKLMNOP '.repeat(4)}PRIVATE KEY BLOCK${'-'.repeat(5)}`
    expect(longestPem.length).toBeLessThanOrEqual(MAX_MATCH_LENGTH)
    expect(scanText(longestPem)).toHaveLength(1)
  })

  it('accepts look-alikes that are not credentials', () => {
    expect(scanText(CLEAN_LOOKALIKES)).toEqual([])
  })

  it('counts CRLF lines and reports one finding per class per line', () => {
    const aws = SECRET_SAMPLES['aws-access-key-id']
    const npm = SECRET_SAMPLES['npm-token']
    expect(scanText(`a\r\nb\r\n${aws} ${aws} ${npm}\r\n`)).toEqual([
      {file: 'sample.ts', line: 3, pattern: 'aws-access-key-id'},
      {file: 'sample.ts', line: 3, pattern: 'npm-token'},
    ])
  })

  it('never carries the matched text in findings or the rejection message', () => {
    const text = Object.values(SECRET_SAMPLES).join('\n')
    const findings = scanText(text)
    expect(findings).toHaveLength(SECRET_PATTERNS.length)
    const output = JSON.stringify(findings) + formatSecretFindings(findings)
    for (const sample of Object.values(SECRET_SAMPLES)) {
      expect(output.includes(sample), 'a sample value leaked into the output').toBe(false)
    }
  })
})

describe('findSecretsInDirectory', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'secret-scan-'))
  })

  afterEach(() => {
    rmSync(root, {recursive: true, force: true})
  })

  it('walks every staged file, whatever the top-level directory is called, and reports posix paths', () => {
    mkdirSync(join(root, 'src', 'nested'), {recursive: true})
    writeFileSync(join(root, 'package.json'), '{}\n')
    writeFileSync(join(root, 'src', 'clean.ts'), `${CLEAN_LOOKALIKES}\n`)
    writeFileSync(join(root, 'src', 'nested', 'config.ts'), `export const a = 1\nexport const b = '${SECRET_SAMPLES['github-token']}'\n`)
    expect(findSecretsInDirectory(root)).toEqual([{file: 'src/nested/config.ts', line: 2, pattern: 'github-token'}])
  })

  it('withholds a file name that itself matches a credential pattern', () => {
    const sample = SECRET_SAMPLES['aws-access-key-id']
    writeFileSync(join(root, `${sample}.txt`), 'clean\n')
    const findings = findSecretsInDirectory(root)
    expect(findings).toEqual([{file: WITHHELD_NAME, line: 0, pattern: 'aws-access-key-id'}])
    const message = formatSecretFindings(findings)
    expect(message).toContain(`  ${WITHHELD_NAME}  AWS access key ID`)
    expect(message.includes(sample), 'the file name leaked into the message').toBe(false)
  })

  it('returns nothing for a clean tree', () => {
    writeFileSync(join(root, 'index.ts'), 'export const ok = true\n')
    expect(findSecretsInDirectory(root)).toEqual([])
  })
})

describe('formatSecretFindings', () => {
  it('names file, line and pattern class and asks for rotation', () => {
    const message = formatSecretFindings([{file: 'custom/config.ts', line: 4, pattern: 'aws-access-key-id'}])
    expect(message).toContain('custom/config.ts:4  AWS access key ID')
    expect(message).toContain('nothing was published')
    expect(message).toContain('rotate')
  })

  it('caps the listing', () => {
    const findings = Array.from({length: 25}, (_, index) => ({file: 'a.ts', line: index + 1, pattern: 'npm-token'}))
    const message = formatSecretFindings(findings)
    expect(message).toContain('a.ts:20  npm token')
    expect(message).not.toContain('a.ts:21  npm token')
    expect(message).toContain('…and 5 more')
  })
})
