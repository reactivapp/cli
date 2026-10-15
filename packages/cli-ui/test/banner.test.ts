import {describe, expect, it} from 'vitest'
import {renderInfo, renderError} from '../src/index.js'

const capture = (columns?: number) => {
  const chunks: string[] = []
  return {
    columns,
    write: (chunk: string) => chunks.push(chunk),
    output: () => chunks.join(''),
  }
}

const lineWidths = (text: string): number[] =>
  text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => [...line].length)

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

  it('fills a narrow terminal without wrapping the box', () => {
    const out = capture(40)
    renderInfo({headline: 'narrow', body: [['x'.repeat(100)]]}, out)
    const widths = lineWidths(out.output())
    expect(Math.max(...widths)).toBe(40)
    expect(widths.every((width) => width <= 40)).toBe(true)
  })

  it('caps the box at 72 columns on a wide terminal', () => {
    for (const columns of [73, 200, 2 ** 31]) {
      const out = capture(columns)
      renderInfo({headline: 'wide'}, out)
      expect(Math.max(...lineWidths(out.output()))).toBe(72)
    }
  })

  it('never shrinks the box below the four columns a border needs', () => {
    const out = capture(2)
    renderInfo({headline: 'tiny'}, out)
    expect(Math.max(...lineWidths(out.output()))).toBe(4)
  })

  it('assumes 80 columns when the stream reports none or an unusable width', () => {
    for (const columns of [undefined, 0, -5, Number.NaN, 12.5]) {
      const out = capture(columns)
      renderInfo({headline: 'fallback'}, out)
      expect(Math.max(...lineWidths(out.output()))).toBe(72)
    }
  })
})
