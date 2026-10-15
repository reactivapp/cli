export type Token =
  | string
  | {command: string}
  | {link: {label: string; url: string}}
  | {filePath: string}

export type TokenLine = Token | Token[]

export const renderToken = (token: Token): string => {
  if (typeof token === 'string') return token
  if ('command' in token) return `\`${token.command}\``
  if ('link' in token) return `${token.link.label} (${token.link.url})`
  return token.filePath
}

export const renderTokenLine = (line: TokenLine): string =>
  Array.isArray(line) ? line.map(renderToken).join(' ') : renderToken(line)
