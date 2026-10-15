import {Banner, type BannerKind, type BannerProps} from './components/Banner.js'
import {renderOnce, type WritableLike} from './render-once.js'
import type {TokenLine} from './tokens.js'

export type {Token, TokenLine} from './tokens.js'

export interface BannerOptions {
  headline: string
  body?: TokenLine[]
  nextSteps?: TokenLine[]
}

const renderBanner = (kind: BannerKind, options: BannerOptions, stream: WritableLike): void => {
  const props: BannerProps = {kind, ...options}
  renderOnce(Banner(props), stream)
}

export const renderInfo = (options: BannerOptions, stream: WritableLike = process.stdout): void =>
  renderBanner('info', options, stream)

export const renderSuccess = (options: BannerOptions, stream: WritableLike = process.stdout): void =>
  renderBanner('success', options, stream)

export const renderWarning = (options: BannerOptions, stream: WritableLike = process.stderr): void =>
  renderBanner('warning', options, stream)

export const renderError = (options: BannerOptions, stream: WritableLike = process.stderr): void =>
  renderBanner('error', options, stream)
