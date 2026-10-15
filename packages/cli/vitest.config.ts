import {defineConfig} from 'vitest/config'

// Several tests run the real npm and git; on a slow CI runner they exceed the
// default 5 second limit.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
})
