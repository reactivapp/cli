import * as readline from 'node:readline/promises'

export interface Prompter {
  readonly interactive: boolean
  line(question: string): Promise<string>
  hidden(question: string): Promise<string>
}

const readHidden = (question: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const stdin = process.stdin
    process.stdout.write(question)
    let value = ''
    const finish = (error?: Error): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish()
        if (char === '\u0003') return finish(new Error('cancelled'))
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    const onEnd = (): void => finish(new Error('cancelled'))
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
    stdin.once('end', onEnd)
  })

export const createTerminalPrompter = (nonInteractive = false): Prompter => ({
  interactive: !nonInteractive && process.stdin.isTTY === true,
  async line(question) {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout})
    try {
      return await rl.question(question)
    } finally {
      rl.close()
    }
  },
  hidden: readHidden,
})

const MAX_KEY_LINE_BYTES = 4096

export const readFirstStdinLine = async (): Promise<string> => {
  let text = ''
  for await (const chunk of process.stdin) {
    text += (chunk as Buffer).toString('utf8')
    if (text.includes('\n') || text.length > MAX_KEY_LINE_BYTES) break
  }
  process.stdin.destroy()
  return text.split('\n')[0] ?? ''
}
