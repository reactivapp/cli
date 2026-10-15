import {Banner, type BannerKind} from './components/Banner.js'
import {renderOnce, type WritableLike} from './render-once.js'
import type {TokenLine} from './tokens.js'

export type {Token, TokenLine} from './tokens.js'

export interface BannerOptions {
  headline: string
  body?: TokenLine[]
  nextSteps?: TokenLine[]
}

const DEFAULT_COLUMNS = 80
const MIN_BANNER_WIDTH = 4
const MAX_BANNER_WIDTH = 72

const bannerWidth = ({columns}: WritableLike): number => {
  const available =
    typeof columns === 'number' && Number.isInteger(columns) && columns > 0 ? columns : DEFAULT_COLUMNS
  return Math.max(MIN_BANNER_WIDTH, Math.min(MAX_BANNER_WIDTH, available))
}

const renderBanner = (kind: BannerKind, options: BannerOptions, stream: WritableLike): void => {
  const width = bannerWidth(stream)
  renderOnce(Banner({kind, width, ...options}), stream, width)
}

export const renderInfo = (options: BannerOptions, stream: WritableLike = process.stdout): void =>
  renderBanner('info', options, stream)

export const renderSuccess = (options: BannerOptions, stream: WritableLike = process.stdout): void =>
  renderBanner('success', options, stream)

export const renderWarning = (options: BannerOptions, stream: WritableLike = process.stderr): void =>
  renderBanner('warning', options, stream)

export const renderError = (options: BannerOptions, stream: WritableLike = process.stderr): void =>
  renderBanner('error', options, stream)
