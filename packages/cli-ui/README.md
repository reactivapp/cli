# @reactivapp/cli-ui

Terminal output components for the [Reactiv Plus CLI](https://github.com/reactivapp/cli). The CLI's commands pass plain data to this package, which renders it once with [Ink](https://github.com/vadimdemedes/ink) and writes the result to a stream. Nothing else in the CLI touches rendering.

This package exists to be installed by `@reactivapp/cli`. Its API may change with any CLI release.

## API

```ts
import {renderInfo, renderSuccess, renderWarning, renderError} from '@reactivapp/cli-ui'

renderSuccess({
  headline: 'Scaffolded Acme',
  body: ['42 files expanded to ./acme', {filePath: './acme/src/index.ts'}],
  nextSteps: ['cd acme', {command: 'reactiv app run ios'}],
})
```

Each function takes `{headline, body?, nextSteps?}` and an optional stream (`process.stdout` for info and success, `process.stderr` for warning and error). Body and next-step lines are tokens or arrays of tokens:

| Token | Rendered as |
| --- | --- |
| `'text'` | text |
| `{command: 'reactiv login'}` | `` `reactiv login` `` |
| `{link: {label, url}}` | `label (url)` |
| `{filePath: 'src/index.ts'}` | `src/index.ts` |

`renderToken` and `renderTokenLine` are exported for callers that need the plain-text form.

## License

Under review; see [LICENSE](https://github.com/reactivapp/cli/blob/main/LICENSE).
