---
'@reactivapp/cli': minor
---

`reactiv app submit` now records the published version with Reactiv and shows where to follow it.

After the publish, the CLI sends the version to Reactiv, which records it as a submission. The receipt keeps its seven lines and adds two: `submission <id>` and `dashboard <link>`, the submission's page in the Reactiv Dashboard; the link is printed once more on a line of its own so it can be opened in one piece. A network or server error is tried three times in all; a refusal is not retried.

If the version cannot be recorded, it stays published and the CLI does not publish it again: it prints why, the version and `reactiv app submit --record <version>` on a line of its own, and exits with an error. The new `--record <version>` flag checks that it was given a draft version and then sends only that record call, with no checks, pack or publish, so it can be run once the cause is fixed.
