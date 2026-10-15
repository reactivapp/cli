// Pure checks behind scripts/internal-reference-scan.mjs. They take file
// paths and contents, so the rules can be tested on seeded strings without
// touching the repository. Every rule looks at the text as written and at
// bounded normalised views of it (split string constants folded, base64 runs
// decoded). Diagnostics name files, lines, hosts, repository identities and
// address domains; redactProblems removes any credential-shaped text from
// them before they are printed.

import {BARE_DOMAIN, findSecrets, globToRegExp, INTERNAL_ENDPOINT, IPV4, IPV6, URL_HOST} from './pack-rules.mjs'

// The one account id fixtures may use. Any other 12-digit run of digits is
// treated as a real account, wherever it appears.
export const PLACEHOLDER_ACCOUNT_ID = '000000000000'

const ACCOUNT_ID = /(?<!\d)\d{12}(?!\d)/g
// Digit runs inside UUIDs and hex digests are not account ids.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HEX_DIGEST = /\b[0-9a-f]{40}(?:[0-9a-f]{24})?(?:[0-9a-f]{64})?\b/gi
const AWS_ARN = /\barn:aws[a-z-]*:/i
const INTERNAL_MARKERS = new RegExp(INTERNAL_ENDPOINT.source, 'gi')

// The registry service names appear in fixtures because the CLI checks the
// shape of every vended registry URL; a fixture host must still carry the
// placeholder account and never a private network suffix.
const SERVICE_MARKER = /^(amazonaws\.com|codeartifact)$/i
const PLACEHOLDER_REGISTRY_HOST = /^(?:[a-z0-9-]+-)?000000000000\.d\.codeartifact\.[a-z0-9-]+\.amazonaws\.com$/i

// Work-tracker references: internal ticket ids carry no meaning for readers
// of this repository and point at systems they cannot open.
const TRACKER_ID = /\bsc-\d+\b/gi

// Hosts on reserved documentation and testing domains are fictional by
// definition and need no allowlist entry.
export const FICTIONAL_HOST = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i

// Template placeholders and truncated literals are not hosts; a bare name
// ending in .sh is a shell script in this repository, not a host on that TLD.
// The shell-script exemption never applies to the host of an explicit URL.
const HOST_SHAPE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)$/i
const SHELL_SCRIPT = /\.sh$/i

const EMAIL = /(?<![\w:])(?<!\/\/)[\w.+-]+@((?:[\w-]+\.)+[a-z]{2,})(?![\w:])/gi

// A credential written as adjacent string constants ("ghp_" + "..."), across
// line breaks or as an array of pieces joined with a constant, is one
// credential. Folding those forms before matching defeats the split.
const STRING_CONCAT = /(["'`])((?:(?!\1)[^\\\n])*)\1\s*\+\s*(["'`])/g
const ARRAY_JOIN = /\[\s*((?:["'`](?:(?!["'`])[^\\\n])*["'`]\s*,?\s*)+)\]\s*\.join\(\s*(["'`])((?:(?!\2)[^\\\n])*)\2\s*\)/g

// Base64 and base64url runs long enough to hold an encoded credential of the
// shortest supported shape (a 20-character access key id).
const BASE64_RUN = /[A-Za-z0-9+/]{24,}={0,2}|[A-Za-z0-9_-]{24,}/g

// Any regular expression that is more than a literal has one of these.
const REGEX_SYNTAX = /[([{|\\]/

const REPOSITORY_URL = /(?:\b(?:git\+)?(?:https?|ssh|git):|(?<![\w:]))\/\/(?:[^/\s'"`)<>@]*@)?([^/\s'"`)<>:?#@]+)(?::\d+)?\/([^\s'"`)<>?#\\]+)/gi
const SCP_URL = /\b[\w.-]+@([a-z0-9.-]+):([^\s'"`)<>?#\\]+)/gi

const ALLOWLIST_FILE = 'scripts/internal-reference-allowlist.json'

const matchesAny = (file, globs) => globs.some(glob => globToRegExp(glob).test(file))
const paths = entries => entries.map(entry => entry.path)

export const joinStringConstants = text => {
  let joined = text
  for (;;) {
    const next = joined
      .replace(ARRAY_JOIN, (_, pieces, quote, separator) => {
        const parts = [...pieces.matchAll(/["'`]((?:(?!["'`])[^\\\n])*)["'`]/g)].map(match => match[1])
        return `${quote}${parts.join(separator)}${quote}`
      })
      .replace(STRING_CONCAT, (_, open, body) => `${open}${body}`)
    if (next === joined) return joined
    joined = next
  }
}

/** The text as written and, when different, with split constants folded. */
export const foldedViews = text => {
  const folded = joinStringConstants(text)
  return folded === text ? [text] : [text, folded]
}

// A run is decoded whole and piece by piece between slashes: a slash is a
// base64 character, but in a path it separates segments.
export const decodeBase64Runs = text => {
  const decoded = []
  for (const match of text.matchAll(BASE64_RUN)) {
    const candidates = new Set([match[0], ...match[0].split('/').filter(piece => piece.length >= 24)])
    for (const candidate of candidates) {
      for (const encoding of ['base64', 'base64url']) {
        const plain = Buffer.from(candidate, encoding).toString('latin1')
        if (plain.length > 0) decoded.push(plain)
      }
    }
  }
  return decoded
}

/** Every bounded view of one line: as written and each base64 run decoded. */
const lineViews = line => [line, ...decodeBase64Runs(line)]

const matchesSecret = (text, patterns) => lineViews(text).some(view => findSecrets('x', view, patterns).length > 0)

/** Secret patterns against each line as written, after folding split constants, and after base64 decoding either. */
export const findEncodedSecrets = (file, content, patterns) => {
  const problems = new Set()
  foldedViews(content).forEach((view, viewIndex) => {
    view.split('\n').forEach((line, index) => {
      if (matchesSecret(line, patterns)) problems.add(`${file}:${index + 1}: matches a secret pattern${viewIndex === 0 ? '' : ' after folding split string constants (line number approximate)'}`)
    })
  })
  return [...problems]
}

/** A pattern-definition file holds reviewed regular expressions only: a line that is a bare literal, or that matches another line directly or after decoding, is a credential, not a pattern. */
export const findSecretsInPatternFile = (file, content) => {
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean)
  const problems = []
  lines.forEach((line, index) => {
    if (!REGEX_SYNTAX.test(line)) {
      problems.push(`${file}:${index + 1}: a pattern line is a bare literal, not a regular expression`)
      return
    }
    const others = lines.filter((_, otherIndex) => otherIndex !== index).map(other => new RegExp(other))
    if (lineViews(line).some(view => others.some(pattern => pattern.test(view)))) {
      problems.push(`${file}:${index + 1}: a pattern line matches another pattern, so it holds a credential value rather than a pattern`)
    }
  })
  return problems
}

const stripDigests = line => line.replace(UUID, '').replace(HEX_DIGEST, '')

export const findAccountIds = (file, content, allowedNumbers = []) => {
  const problems = new Set()
  for (const view of foldedViews(content)) {
    view.split('\n').forEach((line, index) => {
      if (AWS_ARN.test(line)) problems.add(`${file}:${index + 1}: AWS ARN`)
      for (const match of stripDigests(line).matchAll(ACCOUNT_ID)) {
        if (match[0] === PLACEHOLDER_ACCOUNT_ID || allowedNumbers.includes(match[0])) continue
        problems.add(`${file}:${index + 1}: 12-digit number (an account id unless listed in allowedNumbers)`)
      }
    })
  }
  return [...problems]
}

/** Internal markers everywhere; fixture paths may name the registry service and the placeholder account host; definition files may hold their exact reviewed lines. */
export const findInternalMarkers = (file, content, config) => {
  const problems = new Set()
  const fixture = matchesAny(file, paths(config.fixturePaths))
  const allowedLines = new Set(config.allowedMarkerLines.filter(entry => entry.path === file).map(entry => entry.line))
  // The allowlist file quotes the allowed lines in its own "line" entries.
  const isAllowlistEntry = line => file === ALLOWLIST_FILE && /^"line": ".*",?$/.test(line.trim())
  const folded = joinStringConstants(content)
  folded.split('\n').forEach((line, index) => {
    if (allowedLines.has(line.trim()) || isAllowlistEntry(line)) return
    for (const match of line.matchAll(INTERNAL_MARKERS)) {
      const marker = match[0]
      if (fixture && (SERVICE_MARKER.test(marker) || marker.toLowerCase() === `reactivapp-${PLACEHOLDER_ACCOUNT_ID}`)) continue
      problems.add(`${file}:${index + 1}: internal infrastructure marker "${marker}"${folded === content ? '' : ' (line number approximate, constants folded)'}`)
    }
  })
  return [...problems]
}

export const findTrackerIds = (file, content) => {
  const problems = new Set()
  for (const view of foldedViews(content)) {
    view.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(TRACKER_ID)) problems.add(`${file}:${index + 1}: work-tracker reference "${match[0]}"`)
    })
  }
  return [...problems]
}

/** Every host the text names, tagged with whether it came from an explicit URL. */
export const extractHostsDetailed = content => {
  const hosts = new Map()
  const add = (host, fromUrl) => {
    const key = host.toLowerCase()
    if (!hosts.has(key) || fromUrl) hosts.set(key, fromUrl)
  }
  for (const match of content.matchAll(URL_HOST)) add(match[1], true)
  for (const match of content.matchAll(IPV4)) add(match[0], false)
  for (const match of content.matchAll(IPV6)) add(`[${match[1]}]`, false)
  for (const match of content.matchAll(BARE_DOMAIN)) add(match[0], false)
  return hosts
}

export const findUnknownHosts = (file, content, allowedHosts) => {
  const allowed = new Set(allowedHosts.map(entry => entry.host))
  const problems = []
  for (const [host, fromUrl] of extractHostsDetailed(joinStringConstants(content))) {
    if (allowed.has(host) || FICTIONAL_HOST.test(host) || PLACEHOLDER_REGISTRY_HOST.test(host)) continue
    if (!HOST_SHAPE.test(host)) continue
    if (!fromUrl && SHELL_SCRIPT.test(host)) continue
    problems.push(`${file}: hostname "${host}" is not in the allowed-hosts list`)
  }
  return problems
}

/** owner/repository from a path, after resolving dot segments the way a browser would. */
const repositoryIdentity = (host, pathname) => {
  let resolved
  try {
    resolved = new URL(`https://${host}/${pathname.replace(/^\/+/, '')}`).pathname
  } catch {
    return undefined
  }
  const segments = resolved.replace(/^\/+/, '').split('/')
  if (segments.length < 2 || segments[0] === '' || segments[1] === '') return undefined
  return `${segments[0]}/${segments[1].replace(/\.git$/i, '')}`.toLowerCase()
}

/** Links on a restricted forge host must name a reviewed owner/repository, in any URL form (https, git+https, ssh, git, scp-style and scheme-relative). */
export const findUnknownLinks = (file, content, config) => {
  const restricted = new Set(config.restrictedUrlHosts.map(host => host.toLowerCase()))
  const allowed = new Set(config.allowedRepositories.map(entry => entry.repository.toLowerCase()))
  const problems = new Set()
  const check = (host, pathname) => {
    if (!restricted.has(host.toLowerCase())) return
    const identity = repositoryIdentity(host, pathname)
    if (identity === undefined || !allowed.has(identity)) problems.add(`${file}: link to ${host.toLowerCase()}/${identity ?? '(unparseable path)'} is outside the reviewed repositories`)
  }
  const folded = joinStringConstants(content)
  for (const match of folded.matchAll(REPOSITORY_URL)) check(match[1], match[2])
  for (const match of folded.matchAll(SCP_URL)) check(match[1], match[2])
  return [...problems]
}

export const findUnknownEmails = (file, content, allowedEmails) => {
  const allowed = new Set(allowedEmails.map(entry => entry.address.toLowerCase()))
  const problems = new Set()
  for (const view of foldedViews(content)) {
    for (const match of view.matchAll(EMAIL)) {
      const address = match[0].toLowerCase()
      if (allowed.has(address) || FICTIONAL_HOST.test(match[1])) continue
      problems.add(`${file}: email address on ${match[1].toLowerCase()} is not in the allowed-emails list`)
    }
  }
  return [...problems]
}

export const scanContent = (file, content, config, secretPatterns) => [
  ...(config.secretPatternFiles.includes(file) ? findSecretsInPatternFile(file, content) : findEncodedSecrets(file, content, secretPatterns)),
  ...findAccountIds(file, content, config.allowedNumbers),
  ...findInternalMarkers(file, content, config),
  ...findUnknownHosts(file, content, config.allowedHosts),
  ...findUnknownLinks(file, content, config),
  ...findUnknownEmails(file, content, config.allowedEmails),
  ...findTrackerIds(file, content),
]

/** A path (or a symlink target) is content too: a name can leak the same way a line can, plainly or base64-encoded. */
export const scanPath = (file, config, secretPatterns) => {
  const label = `path ${file}`
  return [
    ...(matchesSecret(file, secretPatterns) ? [`${label}: the name matches a secret pattern`] : []),
    ...findAccountIds(label, file, config.allowedNumbers),
    ...findInternalMarkers(label, file, {...config, fixturePaths: [], allowedMarkerLines: []}),
    ...findUnknownHosts(label, file, config.allowedHosts),
    ...findUnknownEmails(label, file, config.allowedEmails),
    ...findTrackerIds(label, file),
  ]
}

const withGlobal = pattern => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)

/** Diagnostics may quote file names, hosts and repository paths; any credential-shaped text in them is replaced before printing. */
export const redactProblems = (problems, secretPatterns) =>
  problems.map(problem => {
    let text = problem
    for (const pattern of secretPatterns) text = text.replace(withGlobal(pattern), '[redacted]')
    for (const run of text.match(BASE64_RUN) ?? []) {
      if (matchesSecret(run, secretPatterns)) text = text.split(run).join('[redacted]')
    }
    return text
  })

const utf16Ratio = (buffer, offset) => {
  const sample = buffer.subarray(0, 2048)
  let nul = 0
  let total = 0
  for (let index = offset; index < sample.length; index += 2) {
    total += 1
    if (sample[index] === 0) nul += 1
  }
  return total === 0 ? 0 : nul / total
}

/** Text for scanning: UTF-16 (with a byte-order mark, or recognisable by its NUL pattern) and UTF-8 are decoded; anything else is read byte for byte. */
export const decodeContent = buffer => {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le')
  if (buffer.length >= 4) {
    if (utf16Ratio(buffer, 1) > 0.6 && utf16Ratio(buffer, 0) < 0.2) return buffer.toString('utf16le')
    if (utf16Ratio(buffer, 0) > 0.6 && utf16Ratio(buffer, 1) < 0.2) return Buffer.from(buffer.subarray(0, buffer.length - (buffer.length % 2))).swap16().toString('utf16le')
  }
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(buffer)
  } catch {
    return buffer.toString('latin1')
  }
}
