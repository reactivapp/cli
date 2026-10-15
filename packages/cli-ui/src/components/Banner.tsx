import {Box, Text} from 'ink'
import {renderTokenLine, type TokenLine} from '../tokens.js'

export type BannerKind = 'info' | 'success' | 'warning' | 'error'

const KIND_COLOR: Record<BannerKind, string> = {
  info: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
}

export interface BannerProps {
  kind: BannerKind
  width: number
  headline: string
  body?: TokenLine[]
  nextSteps?: TokenLine[]
}

export const Banner = ({kind, width, headline, body, nextSteps}: BannerProps) => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor={KIND_COLOR[kind]}
    paddingX={1}
    width={width}
  >
    <Text bold color={KIND_COLOR[kind]}>
      {kind} — {headline}
    </Text>
    {body?.map((line, index) => (
      <Text key={index}>{renderTokenLine(line)}</Text>
    ))}
    {nextSteps && nextSteps.length > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Next steps</Text>
        {nextSteps.map((line, index) => (
          <Text key={index}>{`  • ${renderTokenLine(line)}`}</Text>
        ))}
      </Box>
    ) : null}
  </Box>
)
