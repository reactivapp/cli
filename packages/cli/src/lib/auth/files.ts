import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const ensurePrivateDir = (dir: string): void => {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700})
  if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700)
}

// Temp file beside the target, then rename: readers see old or new content, never partial. Mode is always 0600.
export const writeFileAtomic = (file: string, content: string): void => {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  let fd: number | undefined
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, file)
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd)
    fs.rmSync(temp, {force: true})
    throw error
  }
}

export const removeFileIfPresent = (file: string): void => {
  fs.rmSync(file, {force: true})
}

export const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error ? String((error as {code: unknown}).code) : undefined
