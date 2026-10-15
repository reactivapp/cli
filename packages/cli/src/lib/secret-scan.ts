import * as fs from 'node:fs'
import * as path from 'node:path'

// Patterns for credentials a submission must never carry.
export const SECRET_PATTERNS: ReadonlyArray<{id: string; label: string; regex: RegExp}> = [
  {id: 'aws-access-key-id', label: 'AWS access key ID', regex: /AKIA[0-9A-Z]{16}/},
  {id: 'aws-secret-access-key', label: 'AWS secret access key', regex: /aws_secret_access_ke[y]/i},
  {id: 'github-token', label: 'GitHub token', regex: /gh[pousr]_[A-Za-z0-9]{36}/},
  {id: 'github-fine-grained-token', label: 'GitHub fine-grained token', regex: /github_pa[t]_[A-Za-z0-9]{22}/},
  {id: 'npm-token', label: 'npm token', regex: /npm_[A-Za-z0-9]{36}/},
  {id: 'pem-private-key', label: 'PEM private key', regex: /-{5}BEGIN (?:[A-Z0-9]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?-{5}/},
  {id: 'reactiv-api-key', label: 'Reactiv API key', regex: /rpk_[0-9A-HJKMNP-TV-Z]{26}_/},
  {id: 'shopify-access-token', label: 'Shopify access token', regex: /shp(?:at|ca|pa|ss)_[0-9a-fA-F]{32}/},
]

// No pattern matches more than MAX_MATCH_LENGTH characters, so an overlong
// line can be trimmed to its last MAX_MATCH_LENGTH - 1 characters without
// losing a match that the next chunk completes.
export const MAX_MATCH_LENGTH = 128
const MAX_CARRY = 8 * 1024
const MAX_FINDINGS_PER_FILE = 20

// Line 0: the match is in the file name, which is therefore not reported.
export const WITHHELD_NAME = '(name withheld: it matches a credential pattern)'

export interface SecretFinding {
  file: string
  line: number
  pattern: string
}

export interface SecretScanner {
  push(chunk: Buffer): void
  end(): SecretFinding[]
}

// latin1 maps bytes one to one, so binary content never fails to decode.
// Findings never carry the matched text.
export const createSecretScanner = (file: string): SecretScanner => {
  const findings: SecretFinding[] = []
  const seen = new Set<string>()
  let carry = ''
  let line = 1

  const nameMatches = SECRET_PATTERNS.filter(({regex}) => regex.test(file))
  const reportedFile = nameMatches.length > 0 ? WITHHELD_NAME : file
  for (const {id} of nameMatches) findings.push({file: reportedFile, line: 0, pattern: id})

  const test = (text: string, lineNumber: number): void => {
    for (const {id, regex} of SECRET_PATTERNS) {
      if (findings.length >= MAX_FINDINGS_PER_FILE) return
      const key = `${id}:${lineNumber}`
      if (seen.has(key) || !regex.test(text)) continue
      seen.add(key)
      findings.push({file: reportedFile, line: lineNumber, pattern: id})
    }
  }

  return {
    push(chunk) {
      const lines = (carry + chunk.toString('latin1')).split('\n')
      carry = lines.pop() ?? ''
      for (const text of lines) {
        test(text, line)
        line += 1
      }
      if (carry.length > MAX_CARRY) {
        test(carry, line)
        carry = carry.slice(-(MAX_MATCH_LENGTH - 1))
      }
    },
    end() {
      if (carry !== '') test(carry, line)
      carry = ''
      return findings
    },
  }
}

const READ_CHUNK_BYTES = 64 * 1024

const scanFile = (absolutePath: string, relativePath: string): SecretFinding[] => {
  const scanner = createSecretScanner(relativePath)
  const buffer = Buffer.alloc(READ_CHUNK_BYTES)
  const fd = fs.openSync(absolutePath, 'r')
  try {
    let bytesRead: number
    while ((bytesRead = fs.readSync(fd, buffer, 0, READ_CHUNK_BYTES, null)) > 0) {
      scanner.push(buffer.subarray(0, bytesRead))
    }
  } finally {
    fs.closeSync(fd)
  }
  return scanner.end()
}

/** Scan every regular file under the staging directory; paths in findings are relative to it, with `/` separators. */
export const findSecretsInDirectory = (rootDir: string): SecretFinding[] => {
  const findings: SecretFinding[] = []
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(entryPath)
      } else if (entry.isFile()) {
        findings.push(...scanFile(entryPath, path.relative(rootDir, entryPath).split(path.sep).join('/')))
      }
    }
  }
  walk(rootDir)
  return findings
}

const MAX_LISTED_FINDINGS = 20

export const formatSecretFindings = (findings: SecretFinding[]): string => {
  const labels = new Map(SECRET_PATTERNS.map(p => [p.id, p.label]))
  const listed = findings
    .slice(0, MAX_LISTED_FINDINGS)
    .map(f => `  ${f.line === 0 ? f.file : `${f.file}:${f.line}`}  ${labels.get(f.pattern) ?? f.pattern}`)
  if (findings.length > MAX_LISTED_FINDINGS) listed.push(`  …and ${findings.length - MAX_LISTED_FINDINGS} more`)
  return [
    'possible credentials found in the submission — nothing was published:',
    ...listed,
    'Treat each one as compromised: revoke and reissue (rotate) it with its provider, then remove it from the source. Removing it alone is not enough if it was ever committed or shared. Keep credentials out of the submitted source entirely.',
  ].join('\n')
}
