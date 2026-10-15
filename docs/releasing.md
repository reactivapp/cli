# Releasing

How `@reactivapp/cli` and `@reactivapp/cli-ui` are versioned and published to the public npm registry. Nobody runs `npm publish` by hand or edits a version number.

## 1. Declare the change

On your branch, with the code change:

```bash
pnpm changeset
```

Pick the affected package(s) and the semver bump, and write a one-line summary; it becomes the changelog entry. Commit the generated `.changeset/*.md` with your pull request. A change that does not affect the published packages (docs, CI, gates) needs no changeset.

## 2. Merge to `main`

The `Version packages` workflow runs on every push to `main`. When pending changesets exist it opens or updates one pull request titled `chore: version packages` (opened with the repository's own token, so a maintainer may need to approve its CI run) that bumps `package.json` versions, writes the changelog entries, deletes the consumed changesets and keeps the `workspace:*` dependency between the two packages aligned. Changesets from several merged pull requests accumulate into that one pull request. Nothing is published at this point.

## 3. Merge the version pull request

Merging it is the release decision: `main` now carries the versions to publish. Still nothing is on npm.

## 4. Publish

Actions → **Release to npmjs** → Run workflow on `main` with `publish` ticked. Unticked (the default) the run only inspects.

1. `inspect` builds, lints, typechecks, tests, runs the gate self-tests, the internal reference scan, the history secret scan and `pnpm pack:inspect --out`, which packs both packages with pnpm and fails on any tarball entry outside the files whitelist, any credential pattern and any hostname not on the allowed list (`scripts/pack-allowlist.json`). The checked tarballs and their `SHA256SUMS` become the run's artifact.
2. `environment-guard` refuses to go on unless the run is on `main`, no unconsumed changeset is left in `.changeset/` (merge the version pull request first), the CI `checks` job succeeded on exactly this commit, the `npmjs` GitHub environment exists with at least one required reviewer, and the repository is public (npm generates provenance only from public repositories).
3. `publish` waits for a reviewer to approve the `npmjs` environment, checks the downloaded tarballs against `SHA256SUMS`, and runs `npm publish <tarball> --access public --provenance` for cli-ui, then the CLI, skipping versions already on npm. Inspected bytes are published bytes.

Before the first publish of a new version, walk through [the release checklist](public-npm-release-checklist.md). It also holds the one-time account and environment setup.

Partial publish recovery: if cli-ui lands and the CLI step fails, fix the cause and re-run the workflow; cli-ui is skipped as already published. A cli-ui version with no matching CLI is inert, since nothing installs it except the CLI. Never unpublish: npm burns the version number anyway.

## What runs where

| Check | Pull requests | `main` | Before publish |
| --- | --- | --- | --- |
| Lint, typecheck, tests | yes | yes | yes |
| Gate self-tests (`pnpm test:gates`) | yes | yes | yes |
| Internal reference scan, tree and file names (`pnpm scan:internal`) | yes | yes | yes |
| Internal reference scan, commit messages | yes | — | — |
| History secret scan (`scripts/secret-scan.sh`) | yes | yes | yes |
| Changeset check (`pnpm changeset status`) | yes | — | refuses unconsumed changesets |
| Green CI on the exact commit | — | — | yes |
| Pack inspection (`pnpm pack:inspect`) | yes | yes | yes, and its tarballs are what ships |

Pull-request jobs hold no credentials, so a pull request from a fork gets the same run.
