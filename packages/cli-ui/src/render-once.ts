import {EventEmitter} from 'node:events'
import {render as inkRender} from 'ink'
import type {ReactElement} from 'react'

export interface WritableLike {
  write(chunk: string): unknown
}

class CaptureStream extends EventEmitter {
  columns = 80
  rows = 24
  private frames: string[] = []

  write = (chunk: string): boolean => {
    // Ink's is-in-ci path emits a bare final "\n" on unmount, which would
    // clobber the last real frame.
    if (chunk !== '\n') {
      this.frames.push(chunk)
    }
    return true
  }

  lastFrame = (): string => this.frames.at(-1) ?? ''
}

export const renderOnce = (element: ReactElement, stream: WritableLike): void => {
  const capture = new CaptureStream()
  const instance = inkRender(element, {
    stdout: capture as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  instance.unmount()
  const frame = capture.lastFrame()
  if (frame.length > 0) {
    stream.write(frame.endsWith('\n') ? frame : `${frame}\n`)
  }
}
