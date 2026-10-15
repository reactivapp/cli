# Public npm release checklist

The sign-off gate before a version of `@reactivapp/cli` and `@reactivapp/cli-ui` is published to the public npm registry. Once published, the code is world-readable forever (npm unpublish is time-limited and leaves the version number burned), so every box below needs a human tick before a `Release to npmjs` run with `publish` ticked. The gate covers **both** packages: cli-ui is the CLI's runtime render layer, and a credential-free `npm i -g @reactivapp/cli` can only install if it is public too.

Automated checks back most rows. The reviewer's job is to confirm they ran, read their output, and decide the items marked **decision**.

## 1. Published surface

Automated: `pnpm pack:inspect` (CI on every pull request and in the release workflow's `inspect` job) packs each package with pnpm and fails on any entry outside the whitelist in `scripts/pack-allowlist.json`, any non-regular file (links) or path traversal, any drift between `package.json` `files` and the gate's copy, install-time lifecycle scripts, non-registry dependency specifiers (`workspace:`, `file:`, git, URLs), and a pinned `publishConfig.registry`. Widening the surface takes two edits in one review: `package.json` `files` and the allowlist. Both files are listed in CODEOWNERS.

Expected tarball contents (`pnpm pack:inspect` prints the live listing):

| Package | Entries |
| --- | --- |
| `@reactivapp/cli` | `package.json`, `README.md`, `LICENSE`, `bin/run`, `dist/index.js`, `dist/commands/{login,logout,whoami}.js`, `dist/commands/app/{init,run,submit,upgrade}.js`, `dist/lib/*.js`, `dist/lib/auth/*.js` |
| `@reactivapp/cli-ui` | `package.json`, `README.md`, `LICENSE`, `dist/{index,render-once,tokens}.{js,d.ts}`, `dist/components/Banner.{js,d.ts}` |

No TypeScript source, source maps, tests, config files, `.npmrc`, or repository docs ship. `LICENSE` is the repository's license file; pnpm adds it to every package tarball. The gate also fails when a file the manifest points at (`main`, `types`, `bin`, `exports`) is missing from the tarball.

- [ ] `pnpm pack:inspect` is green in CI on the release commit and its listing matches the table above
- [ ] License: the license Reactiv selected is in `LICENSE` and in both `package.json` `license` fields. Until then both packages say `"license": "UNLICENSED"` and the shipped `LICENSE` reserves all rights; the first public publish waits for the decision.
- [ ] Each package ships its own `README.md` (npm renders it on the package page) and its links are absolute.

## 2. Secrets

Automated: the pack inspection extracts each tarball and matches every line against `scripts/secret-patterns.ere`, the same pattern set the git-history scan `scripts/secret-scan.sh` and the repository-wide scan `scripts/internal-reference-scan.mjs` use (AWS access key IDs, the AWS secret-key config name, GitHub classic, OAuth, app and refresh tokens and fine-grained PATs, npm tokens, PEM headers, Reactiv API keys). Matches are reported by file and line without echoing the value. The tarball inspection and the history scan match literally: a secret that is encoded or split across string pieces does not match there. The repository scan (`pnpm scan:internal`) also folds split string constants and decodes base64 runs, but hex encoding and other arbitrary encodings are not recognised by any of them. That is why the manual read below is part of the gate.

- [ ] Pack inspection reports no secret matches for either package
- [ ] `bash scripts/secret-scan.sh` prints `CLEAN` on the release commit. Patches are matched against the shared pattern set (the pattern-definition files themselves are excluded); commit messages are matched against `scripts/secret-message-patterns.ere`, which only flags complete credentials
- [ ] `pnpm scan:internal`, `pnpm scan:internal --messages <previous release>..HEAD` and `pnpm scan:internal --history <previous release>..HEAD` are green on the release commit (credentials, also encoded or split; account ids; internal hosts; repository links and addresses outside the allowlists; tracker references; across every file, file name, symlink target, commit message and introduced file version)
- [ ] Reviewer has read the test fixtures, the docs and the package metadata once for identities the scanner cannot judge by shape: every merchant slug, app UUID, bundle identifier, person and hostname in them is fictional or on an allowlist
- [ ] The pattern set is known to be narrow (no generic high-entropy detection), and a bare hostname without a scheme is only recognised on the fixed TLD list in `scripts/lib/pack-rules.mjs`. Reviewer has read the shipped `dist/` files once by hand, looking for both. They are small: under 40 files across both packages.

## 3. Endpoints

Automated: the pack inspection pulls every URL host, bare domain, and IPv4 literal out of each shipped file and fails on any host not listed in `scripts/pack-allowlist.json` `allowedHosts`. Bare hostnames without a scheme are recognised by a fixed TLD list, and IPv6 only in bracketed form, so the manual read in section 2 covers anything more exotic. It also rejects internal infrastructure markers even when a URL is assembled at runtime: the cloud provider and registry service names, the private-network host suffix, and the account-qualified registry domain prefix (the pattern is `INTERNAL_ENDPOINT` in `scripts/lib/pack-rules.mjs`).

Every host in shipped code today (informational snapshot; the enforced source of truth is `allowedHosts` in `scripts/pack-allowlist.json`):

| Host | Where | Why it is there |
| --- | --- | --- |
| `127.0.0.1` | `dist/commands/app/run.js`, `dist/lib/auth/vending-client.js` | `reactiv app run` checks whether a Metro dev server already holds port 8081 on the developer's own machine; the token-service client accepts a plain-http `REACTIV_VENDING_API_URL` override only on loopback (mock servers) |
| `[::1]` | `dist/lib/auth/vending-client.js` | IPv6 loopback literal for the same plain-http mock-server override |
| `plus-devtools-staging.dev.reactivapp.com` | `dist/lib/auth/vending-client.js` | The token service the CLI uses by default (`DEFAULT_VENDING_API_URL`); by default the only service the CLI sends the API key to, the `REACTIV_VENDING_API_URL` override being the one way to change that. This hostname is the shipped default today; a later release switches the default to `plus-devtools.reactivapp.com`. Other environments are reached through the `REACTIV_VENDING_API_URL` override |
| `github.com` | `package.json` `repository` | npm provenance requires the repository URL to match the publishing repository |

No registry URL ships in the CLI: both registry URLs come from the token service's response, and the CLI writes a token only after checking each one is an https endpoint on the expected registry host shape. That check needs a generic host pattern (it names no account, domain or region), which the internal-infrastructure rule would otherwise flag; the exact pattern literal and its refusal message are the two entries in `allowedLiterals` in `scripts/pack-allowlist.json`. Only those exact strings are exempt; the same markers anywhere else still fail the gate.

Registry *names* still appear: the CLI runs `npm view`/`npm pack` for `@reactivapp/mobile` and `@reactivapp/app-template`. These are package names resolved through the developer's own npm config. They are not endpoints, and the packages stay in Reactiv's private registry.

- [ ] Pack inspection reports no endpoint problems; the table above matches `allowedHosts`, and `allowedLiterals` holds only the registry host-shape check and its message
- [ ] **decision** — scope routing: developers whose `.npmrc` maps `@reactivapp:registry` to Reactiv's private registry will resolve `@reactivapp/cli` from there, not from npm, inside that config. Confirm this is acceptable, or document `npm i -g @reactivapp/cli --registry https://registry.npmjs.org/` for day zero.

## 4. Dependencies

- Direct runtime deps: `@oclif/core`, `typescript`, `@reactivapp/cli-ui` (workspace, published alongside); cli-ui: `ink`, `react`.
- `typescript` is a runtime dependency on purpose. `reactiv app submit` uses the compiler API as a parser for the entry-point and import checks. It is the heaviest part of the install.
- `ink` depends on `ws` for its optional React DevTools bridge. It only activates when `DEV=true` and the optional peer `react-devtools-core` is installed, and it connects to localhost. Neither the CLI nor cli-ui sets either.
- `@oclif/core` has no update-check or telemetry of its own. The plugins that add them are not installed.
- Dependency confusion: once `@reactivapp` is owned on npm, nobody else can publish a same-named `@reactivapp/*` package there.

- [ ] `pnpm audit --prod` run on the release commit; any advisory is triaged here before publishing
- [ ] No package in the production closure declares a `preinstall`, `install` or `postinstall` script (the pack gate checks the published packages themselves; this covers their closure):

  ```bash
  for dir in $(pnpm list --prod --depth Infinity --parseable -r | sort -u); do
    node -e "const m=require('$dir/package.json');for(const s of ['preinstall','install','postinstall'])if(m.scripts?.[s])console.log(m.name,s)"
  done
  ```
- [ ] The `@reactivapp` scope on npm is owned by the Reactiv organisation, not a personal account, with two-factor authentication required for its members

## 5. Provenance and the publish gate

`.github/workflows/release-npmjs.yml` is the only path to npm. The gates stack:

1. Trigger is `workflow_dispatch` only, with `publish` defaulting to `false`. `pull_request` runs (path-scoped to the workflow and gate files) inspect only.
2. `environment-guard` fails unless the ref is `main`, no unconsumed changeset remains, the CI `checks` job succeeded on this exact commit, the `npmjs` environment exists with at least one required reviewer, and the repository is public. Without the environment check, GitHub would auto-create a missing environment, unprotected, at job start. The visibility check stops a provenance failure from happening halfway through the publish loop.
3. `publish` declares `environment: npmjs`, so it pauses for a required reviewer's approval.
4. `publish` verifies the downloaded tarballs against the inspect job's `SHA256SUMS`: inspected bytes are published bytes.
5. `npm publish --provenance` is explicit, so npm fails instead of silently publishing without an attestation.

Making this repository private again later stops every future release at the guard step, and at npm's provenance check if the guard is bypassed.

Environment setup as decided for this repository: two required reviewers, "prevent self-review" on, deployment branch `main` only. Repository administrators keep the ability to bypass the environment's protection rules; the reviewer pause therefore binds everyone except administrators, by decision.

One-time setup (human, in this order):

- [x] npm: `@reactivapp` organisation created and owned; publishing members have two-factor authentication enforced
- [x] GitHub: environment `npmjs` created with required reviewers (prevent self-review enabled), deployment branches limited to `main`
- [ ] First publish credentials: npm trusted publishing is configured per package only once the package exists, so the first run uses a short-lived granular token scoped to `@reactivapp` with publish rights, stored as the `NPM_TOKEN` secret **on the `npmjs` environment** (not the repository). The workflow passes it as `NODE_AUTH_TOKEN`.
- [ ] After the first publish: on npm, for each package, configure the trusted publisher (GitHub Actions, organisation `reactivapp`, repository `cli`, workflow `release-npmjs.yml`, environment `npmjs`) and set "require two-factor authentication and disallow tokens"; then delete the granular token on npm and the `NPM_TOKEN` environment secret. With no token present the publish step authenticates over OIDC.

## Sign-off

| Area | Reviewer | Date | Notes |
| --- | --- | --- | --- |
| Published surface | | | |
| Secrets | | | |
| Endpoints | | | |
| Dependencies | | | |
| Provenance and publish gate | | | |

The first publish is triggered by a human, after this table is complete.
