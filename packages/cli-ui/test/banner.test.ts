import {describe, expect, it} from 'vitest'
import {renderInfo, renderError} from '../src/index.js'

const capture = () => {
  const chunks: string[] = []
  return {
    write: (chunk: string) => chunks.push(chunk),
    output: () => chunks.join(''),
  }
}

describe('banners', () => {
  it('renders headline, body tokens, and next steps inside a box', () => {
    const out = capture()
    renderInfo(
      {
        headline: 'reactiv app init',
        body: [['Not implemented yet.', {command: 'reactiv app init --help'}]],
        nextSteps: [{link: {label: 'Docs', url: 'https://example.com/spec'}}],
      },
      out,
    )
    const text = out.output()
    expect(text).toContain('info — reactiv app init')
    expect(text).toContain('Not implemented yet')
    expect(text).toContain('`reactiv app init --help`')
    expect(text).toContain('Docs (https://example.com/spec)')
    expect(text).toContain('╭')
    expect(text).toContain('╰')
  })

  it('renders error banners', () => {
    const out = capture()
    renderError({headline: 'submission rejected'}, out)
    expect(out.output()).toContain('error — submission rejected')
  })
})
