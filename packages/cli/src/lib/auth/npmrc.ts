import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {AuthError} from './errors'
import {errorCode, writeFileAtomic} from './files'

export const BLOCK_START = '# >>> reactiv (managed — do not edit; run `reactiv login` to refresh) >>>'
export const BLOCK_END = '# <<< reactiv <<<'

export const TOOLS_SCOPE = '@reactivapp'
export const SUBMISSIONS_SCOPE = '@reactiv-submissions'

export const VENDED_REGISTRY_HOST = /^[a-z0-9-]+\.d\.codeartifact\.[a-z0-9-]+\.amazonaws\.com$/

export interface RegistryBlock {
  token: string
  expiresAt: string
  registryUrl: string
  toolsRegistryUrl: string
}

export const validateRegistryUrl = (raw: unknown): string => {
  const refuse = (): never => {
    throw new AuthError('vending API returned a registry URL outside CodeArtifact — nothing written')
  }
  if (typeof raw !== 'string' || raw.includes('?') || raw.includes('#')) refuse()
  let url: URL
  try {
    url = new URL(raw as string)
  } catch {
    return refuse()
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !VENDED_REGISTRY_HOST.test(url.hostname) ||
    !url.pathname.endsWith('/')
  ) {
    refuse()
  }
  return url.href
}

// npm's ini parser trims and unquotes values and treats `;`/`#` as comments.
// A denylist rather than an allowlist, so new token characters keep working.
export const assertTokenSafe = (token: unknown): string => {
  const unsafe = new AuthError("registry token contains a character npm's ini format cannot carry safely — nothing written")
  if (typeof token !== 'string' || token === '') throw unsafe
  if (/[${};#\r\n]/.test(token)) throw unsafe
  if (token !== token.trim()) throw unsafe
  if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0]) throw unsafe
  return token
}

const authKey = (registryUrl: string): string => {
  const url = new URL(registryUrl)
  return `//${url.host}${url.pathname}:_authToken`
}

const expiryComment = (expiresAt: string): string => {
  const parsed = Date.parse(expiresAt)
  if (!Number.isFinite(parsed)) throw new AuthError('vending API returned an unreadable token expiry — nothing written')
  return `# token expires ${new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z')}`
}

export const renderBlock = (block: RegistryBlock): string => {
  const token = assertTokenSafe(block.token)
  const tools = validateRegistryUrl(block.toolsRegistryUrl)
  const submissions = validateRegistryUrl(block.registryUrl)
  return [
    BLOCK_START,
    expiryComment(block.expiresAt),
    `${TOOLS_SCOPE}:registry=${tools}`,
    `${SUBMISSIONS_SCOPE}:registry=${submissions}`,
    `${authKey(tools)}=${token}`,
    `${authKey(submissions)}=${token}`,
    'legacy-peer-deps=true',
    BLOCK_END,
  ].join('\n')
}

const stripCarriageReturn = (line: string): string => line.replace(/\r$/, '')

const findBlocks = (lines: string[], file: string): Array<[number, number]> => {
  const blocks: Array<[number, number]> = []
  let open: number | undefined
  const lone = (index: number): never => {
    throw new AuthError(
      `${file} line ${index + 1} has a reactiv marker without its partner; delete that stray marker line and run the command again — nothing was changed`,
    )
  }
  lines.forEach((rawLine, index) => {
    const line = stripCarriageReturn(rawLine)
    if (line === BLOCK_START) {
      if (open !== undefined) lone(open)
      open = index
    } else if (line === BLOCK_END) {
      if (open === undefined) lone(index)
      blocks.push([open as number, index])
      open = undefined
    }
  })
  if (open !== undefined) lone(open)
  return blocks
}

const withoutBlocks = (lines: string[], blocks: Array<[number, number]>): string[] =>
  lines.filter((_, index) => !blocks.some(([start, end]) => index >= start && index <= end))

export const isConflictingLine = (rawLine: string): boolean => {
  const line = stripCarriageReturn(rawLine).trim()
  if (line === '' || line.startsWith('#') || line.startsWith(';')) return false
  const separator = line.indexOf('=')
  if (separator === -1) return false
  const key = line.slice(0, separator).trim()
  if (key === `${TOOLS_SCOPE}:registry` || key === `${SUBMISSIONS_SCOPE}:registry`) return true
  if (key.startsWith('//') && key.endsWith(':_authToken')) {
    const host = key.slice(2).split('/')[0].replace(/:\d+$/, '').toLowerCase()
    return VENDED_REGISTRY_HOST.test(host)
  }
  return false
}

export interface PlannedNpmrc {
  content: string
  removedConflicts: number
}

export const planNpmrc = (existing: string, block: string, file: string): PlannedNpmrc => {
  const lines = existing === '' ? [] : existing.split('\n')
  const kept = withoutBlocks(lines, findBlocks(lines, file))
  const remaining = kept.filter(line => !isConflictingLine(line))
  let text = remaining.join('\n')
  if (text !== '' && !text.endsWith('\n')) text += '\n'
  return {content: `${text}${block}\n`, removedConflicts: kept.length - remaining.length}
}

export const installRoots = (projectRoot: string): string[] =>
  [projectRoot, path.join(projectRoot, 'app')].filter(dir => fs.existsSync(path.join(dir, 'package.json')))

export type GitIgnoreState = 'ignored' | 'not-ignored' | 'no-repository'

export const gitProbeEnv = (): NodeJS.ProcessEnv => {
  const env = {...process.env}
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES']) delete env[name]
  return env
}

export const gitIgnoreState = (file: string): GitIgnoreState => {
  const cwd = path.dirname(file)
  const result = spawnSync('git', ['check-ignore', '-q', '--', path.basename(file)], {cwd, stdio: 'ignore', env: gitProbeEnv()})
  if (result.status === 0) return 'ignored'
  if (result.status === 1) return 'not-ignored'
  if (result.error && errorCode(result.error) === 'ENOENT') return 'no-repository'
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {cwd, encoding: 'utf8', env: gitProbeEnv()})
  if (probe.status !== 0 && /not a git repository \(or any/i.test(probe.stderr ?? '')) return 'no-repository'
  throw new AuthError(`could not ask git whether ${file} is ignored; refusing to write a token into it — check \`git status\` in ${cwd}`)
}

export interface NpmrcWriteOptions {
  log: (message: string) => void
  chmod?: (file: string, mode: number) => void
  ignoreState?: (file: string) => GitIgnoreState
}

interface PreparedWrite {
  file: string
  content: string
  existing: string | undefined
  removedConflicts: number
  mode: number | undefined
}

const prepareWrite = (file: string, block: string, options: NpmrcWriteOptions): PreparedWrite => {
  let stat: fs.Stats | undefined
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  if (stat?.isSymbolicLink()) {
    throw new AuthError(`${file} is a symlink to ${fs.readlinkSync(file)}; refusing to write a token through a link — replace it with a regular file`)
  }
  if (stat && !stat.isFile()) throw new AuthError(`${file} is not a regular file; refusing to write a token into it`)
  if ((options.ignoreState ?? gitIgnoreState)(file) === 'not-ignored') {
    throw new AuthError(
      `${file} is not ignored by git; add \`.npmrc\` to .gitignore (and \`git rm --cached .npmrc\` if it is tracked) before the CLI will write a token into it`,
    )
  }
  const existing = stat ? fs.readFileSync(file, 'utf8') : undefined
  const planned = planNpmrc(existing ?? '', block, file)
  return {file, content: planned.content, existing, removedConflicts: planned.removedConflicts, mode: stat?.mode}
}

const commitWrite = (prepared: PreparedWrite, options: NpmrcWriteOptions): boolean => {
  const {file, content, existing, removedConflicts, mode} = prepared
  if (mode !== undefined && (mode & 0o077) !== 0) {
    try {
      ;(options.chmod ?? fs.chmodSync)(file, 0o600)
    } catch {
      throw new AuthError('could not make `.npmrc` private (0600); refusing to write a token into a readable file')
    }
    options.log(`Made ${file} private (mode 0600) before writing the registry token.`)
  }
  if (content === existing) return false
  writeFileAtomic(file, content)
  if (removedConflicts > 0) {
    options.log(`Removed ${removedConflicts} conflicting registry line(s) from ${file}; the reactiv block now owns them.`)
  }
  return true
}

// Every file is checked before any is written, so one refusal leaves all untouched.
export const writeManagedBlocks = (dirs: string[], block: string, options: NpmrcWriteOptions): string[] => {
  const prepared = dirs.map(dir => prepareWrite(path.join(dir, '.npmrc'), block, options))
  return prepared.filter(write => commitWrite(write, options)).map(write => write.file)
}

export const removeManagedBlock = (file: string, warn: (message: string) => void): boolean => {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
  if (!stat.isFile()) {
    warn(`${file} is not a regular file; left it untouched`)
    return false
  }
  const existing = fs.readFileSync(file, 'utf8')
  const lines = existing.split('\n')
  let blocks: Array<[number, number]>
  try {
    blocks = findBlocks(lines, file)
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error))
    return false
  }
  if (blocks.length === 0) return false
  writeFileAtomic(file, withoutBlocks(lines, blocks).join('\n'))
  return true
}
