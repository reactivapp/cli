// Pure checks behind scripts/pack-inspect.mjs. Everything here takes plain data
// (tarball entry lists, file contents, the packed package.json) so the rules can
// be tested without packing anything.

const TARBALL_PREFIX = 'package/'

// Lifecycle scripts npm runs on the installing machine. A public CLI must never
// execute code at install time.
const INSTALL_TIME_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']

// A dependency resolves from the registry only as a version range, a dist-tag
// or an `npm:` alias. Anything with a protocol, a path or an owner/repo shape
// (workspace:, file:, git hosts, `team/repo`, `./dir`, tarball URLs) does not,
// and neither do the bare local forms npm also accepts: `.`, `..`, `~/dir` and
// a local tarball name like `helper.tgz`.
const LOCAL_BARE_SPECIFIER = /^(\.{1,2}|~.*|.*\.(tgz|tar|tar\.gz))$/i
const isRegistrySpecifier = specifier =>
  specifier.startsWith('npm:') || (!/[:/\\]/.test(specifier) && !LOCAL_BARE_SPECIFIER.test(specifier))

// Infrastructure hostnames that must never ship, even without a URL scheme.
export const INTERNAL_ENDPOINT = /(amazonaws\.com|codeartifact|\.internal\b|reactivapp-\d{12})/i

// Optional userinfo (`git@`) is skipped so the capture is the host alone.
export const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^/\s'"`)<>@]*@)?([^/\s'"`)<>:?#@]+)/gi
export const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
// Bracketed, as IPv6 literals appear in URLs and host:port strings.
export const IPV6 = /\[([0-9a-f]*:[0-9a-f]*:[0-9a-f:.]*)\]/gi
// Hostnames written without a scheme are only recognisable by their TLD. TLDs
// that double as common property or file names (.link, .info, .me, .local,
// .so, ...) are left out: `token.link` in compiled JS is not a host.
// TLDs that are also common property names in compiled JavaScript (.at, .be,
// .in, .host, .run, .page, .email, ...) stay out for the same reason.
export const BARE_DOMAIN =
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|aws|cloud|co|sh|ca|us|uk|eu|biz|tech|xyz|internal|tools|systems|technology|engineering|solutions|software|digital|agency|company|partners|cc|tv|gg|de|fr|nl|se|es|it|jp|au|br|ch|ie|fi|no|dk|pl|cz)\b/gi

export const globToRegExp = glob => {
  let pattern = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      pattern += '(?:.*/)?'
      i += 2
    } else if (char === '*' && glob[i + 1] === '*') {
      pattern += '.*'
      i += 1
    } else if (char === '*') {
      pattern += '[^/]*'
    } else {
      pattern += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${pattern}$`)
}

/** Entries outside the whitelist, or not regular files. Entries carry the tarball's package/ prefix. */
export const findDisallowedEntries = (entries, allowedGlobs) => {
  const matchers = allowedGlobs.map(globToRegExp)
  const problems = []
  for (const {path, type} of entries) {
    if (!path.startsWith(TARBALL_PREFIX)) {
      problems.push(`${path}: outside the package/ root`)
      continue
    }
    const relative = path.slice(TARBALL_PREFIX.length)
    if (relative.split('/').includes('..')) {
      problems.push(`${path}: path traversal`)
    } else if (type !== 'file') {
      problems.push(`${path}: not a regular file (${type})`)
    } else if (!matchers.some(matcher => matcher.test(relative))) {
      problems.push(`${path}: not in the files whitelist`)
    }
  }
  return problems
}

const MANIFEST_TARGET_FIELDS = ['main', 'types', 'bin', 'exports']

const targetPaths = value => {
  if (typeof value === 'string') return value.startsWith('./') ? [value.slice(2)] : [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(targetPaths)
  return []
}

/** Every file the manifest points at (main, types, bin, exports) must be in the tarball. */
export const findMissingTargets = (manifest, entryPaths) => {
  const packed = new Set(entryPaths.map(entry => entry.replace(/^package\//, '')))
  const problems = []
  for (const field of MANIFEST_TARGET_FIELDS) {
    for (const target of targetPaths(manifest[field])) {
      if (!packed.has(target)) problems.push(`package.json ${field} points at ${target}, which is not in the tarball`)
    }
  }
  if ([...packed].filter(entry => entry.endsWith('.js')).length === 0) problems.push('the tarball holds no JavaScript file')
  return problems
}

export const checkPackedManifest = (manifest, expected, entryPaths) => {
  const problems = entryPaths === undefined ? [] : findMissingTargets(manifest, entryPaths)
  if (manifest.name !== expected.name) {
    problems.push(`package.json name is ${manifest.name}, expected ${expected.name}`)
  }
  if (manifest.private === true) {
    problems.push('package.json is marked private')
  }
  const files = [...(manifest.files ?? [])].sort()
  const expectedFiles = [...expected.files].sort()
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    problems.push(
      `package.json files is ${JSON.stringify(manifest.files ?? null)}, the gate expects ${JSON.stringify(expected.files)} — widening the published surface needs both changed in the same review`,
    )
  }
  for (const script of INSTALL_TIME_SCRIPTS) {
    if (manifest.scripts?.[script] !== undefined) {
      problems.push(`package.json has a "${script}" script, which would run on every installing machine`)
    }
  }
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field]
    if (!deps || Array.isArray(deps)) continue
    for (const [name, specifier] of Object.entries(deps)) {
      if (!isRegistrySpecifier(String(specifier))) {
        problems.push(`${field}.${name} is "${specifier}", which does not resolve from the public registry`)
      }
    }
  }
  if (manifest.publishConfig?.registry !== undefined) {
    problems.push(`publishConfig.registry is set (${manifest.publishConfig.registry}); the release workflow chooses the registry`)
  }
  return problems
}

// One extended regex per line, no comment syntax: `grep -Ef` in
// scripts/secret-scan.sh reads the same file and would treat a comment as a pattern.
export const compileSecretPatterns = source => {
  const lines = source.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length === 0) throw new Error('secret pattern file is empty')
  return lines.map(line => new RegExp(line))
}

export const findSecrets = (fileName, content, patterns) => {
  const problems = []
  content.split('\n').forEach((line, index) => {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        // Report the location and pattern only; echoing the matched line
        // would print the secret into the CI log.
        problems.push(`${fileName}:${index + 1}: matches secret pattern ${pattern.source.slice(0, 40)}…`)
      }
    }
  })
  return problems
}

/** Every hostname or IP literal the file mentions. */
export const extractHosts = content => {
  const hosts = new Set()
  for (const match of content.matchAll(URL_HOST)) hosts.add(match[1].toLowerCase())
  for (const match of content.matchAll(IPV4)) hosts.add(match[0])
  for (const match of content.matchAll(IPV6)) hosts.add(`[${match[1].toLowerCase()}]`)
  for (const match of content.matchAll(BARE_DOMAIN)) hosts.add(match[0].toLowerCase())
  return hosts
}

// Exact strings a reviewed allowlist entry permits (a host-shape pattern, not
// an endpoint) are cut out before scanning; the same marker anywhere else in
// the file is still reported.
export const findEndpointProblems = (fileName, content, allowedHosts, allowedLiterals = []) => {
  const allowed = new Set(allowedHosts.map(entry => entry.host))
  const scanned = allowedLiterals.reduce((text, entry) => text.split(entry.literal).join(''), content)
  const problems = []
  if (INTERNAL_ENDPOINT.test(scanned)) {
    problems.push(`${fileName}: references internal infrastructure (${scanned.match(INTERNAL_ENDPOINT)[0]})`)
  }
  for (const host of extractHosts(scanned)) {
    if (!allowed.has(host)) {
      problems.push(`${fileName}: hostname "${host}" is not in the allowed-hosts list`)
    }
  }
  return problems
}
