# @reactivapp/cli

## 0.9.0

### Minor Changes

- 3ea83db: One `npm install` for the whole project, and no more peers arriving uninvited.

  The app template now lists `app/` as an npm workspace of the project root, so `reactiv app init` and `reactiv app upgrade` run a single `npm install` at the root that installs the library's dependencies and the shell's platform into one `node_modules`. Adding a package is one command at the root; `app/package.json` pins the platform and declares nothing else, and the sync check reports a library package that still appears there instead of asking you to mirror it. The installed-version, nested-copy, podspec and lockfile checks read the root tree and the root `package-lock.json`.

  Every install also runs with `--legacy-peer-deps`, and the managed block the CLI writes into the project's `.npmrc` files sets `legacy-peer-deps=true` so your own `npm install` behaves the same way: npm no longer pulls in packages that a transitive dependency names as a peer. A fresh scaffold was failing with ERESOLVE when such a peer's newest release conflicted with the platform's `react-native`, even though nothing in the project used it.

  Projects scaffolded before this release do not list the workspace; the CLI says so and asks for a fresh `reactiv app init`, into which `src/` moves unchanged. This release needs an app template that carries the workspace; an older template is refused at `init` with the same hint.

## 0.8.0

### Minor Changes

- f61319f: `reactiv app init` no longer asks for an app name and no longer takes `--name`. The merchant slug from your login now names the folder, the package, the app shown in the shell and `appName` in `reactiv.conf.js`, next to the app UUID from the same login.

### Patch Changes

- 8ee052c: Banners now fit the terminal: they use the destination stream's width, up to 72 columns, instead of a fixed 72 columns that wrapped in narrower windows. The `@reactivapp/cli` package README now states the Xcode 26.1 requirement for running the app.
- Updated dependencies [8ee052c]
  - @reactivapp/cli-ui@0.1.3

## 0.7.0

### Minor Changes

- 1d4950f: `reactiv app init` takes the merchant slug and app UUID from your login: the slug names the folder, the package and the default bundle identifier, the app name is free text shown in the app, and `--app-uuid` is optional and refused when it differs from the login. Projects identify themselves by the root package name, with the app name as a fallback for projects scaffolded before this release. `reactiv app submit` also scans for Shopify access tokens, and the Windows refusal now covers every command that uses the login and `reactiv app run`, not only `login`; `reactiv logout` still runs anywhere so stored credentials can be removed.

### Patch Changes

- 1d4950f: The CLI is now developed and published from the public repository at github.com/reactivapp/cli. Both packages point their `repository`, `homepage` and `bugs` fields there and ship a README.
- Updated dependencies [1d4950f]
  - @reactivapp/cli-ui@0.1.2

## 0.6.0

### Minor Changes

- Add `reactiv app upgrade [--to <version>]`: moves a scaffolded project to another `@reactivapp/mobile` platform version (default: the version `reactiv app init` installs today), sets the platform-pinned `react`/`react-native` in both manifests, reinstalls with install scripts off, prints the `pod install` step and any toolchain file changes the current app template carries, and runs the project typecheck. A failed typecheck keeps the change and prints the one-command rollback.
- The default token service endpoint is now `plus-devtools-staging.dev.reactivapp.com`. `REACTIV_VENDING_API_URL` still overrides it.

### Patch Changes

- Imports of the platform's library aliases (`@reactiv-mobile-core`, `@reactiv-mobile-core-framework`, `@reactiv-mobile-ui-kit`) are accepted by `reactiv app submit` again; subpaths into them are still refused.

## 0.5.0

### Minor Changes

- `reactiv app submit` now validates the library's declared dependencies before requesting a registry token: every package `src/` imports must be declared in `dependencies`, platform packages may only be imported by their public entry, Node built-ins are refused, and libraries that need native project changes (podspec build hooks or a known list) are refused; a declared dependency nothing imports gets a warning. `peerDependencies` are no longer included in the submission manifest.

## 0.4.0

### Minor Changes

- `reactiv login`, `logout` and `whoami`: sign in with a Reactiv-issued API key (or `REACTIV_API_KEY`), accept the Reactiv Plus terms in the CLI, and let the CLI mint, cache and refresh registry tokens through Reactiv's token service. `app init` and `app submit` take both registry URLs from the token response and keep a managed token block in the project's `.npmrc`; the `@reactiv-submissions:registry` npm-config lookup and the placeholder token variable are gone.
- Projects are now a library at the root (`package.json` + `src/`, what gets submitted) with a runnable shell in `app/`. `reactiv app init` installs both without running lifecycle scripts (it warns when a package in `app/` declares one) and refuses a template that predates this layout. `reactiv app run ios` builds and serves from `app/`. `reactiv app submit` packs the root library: it keeps the library's `dependencies`/`peerDependencies` and entry fields, stamps name, version and `reactivPlus`, drops local-only fields such as `devDependencies` and `scripts`, and requires `files: ["src"]`. Both commands first check that `app/package.json` mirrors the library's dependencies and print the exact edit when it does not; `app submit` additionally requires exact registry versions for the library's dependencies, and runs these checks before requesting a registry token. Projects on the old `custom/` layout get a re-scaffold hint.
- `reactiv app submit` now scans the staged submission for credentials before packing it: AWS access keys and secret-key assignments, GitHub tokens, npm tokens, PEM private-key headers and Reactiv API keys. A match stops the submit (dry runs included) and lists each file, line and credential type, never the value, with a reminder to rotate the credential.

## 0.3.0

### Minor Changes

- `reactiv app submit` now publishes drafts as semver prereleases: `<base>-draft.N`, where `<base>` is the version approval will publish (highest plain `x.y.z` in the merchant's registry with the patch bumped, `0.1.0` on an empty registry) and `N` continues from the highest existing draft of that base. A resubmit increments `N`; once approval publishes `<base>`, the next submit starts `<next base>-draft.1`. Allocation still reads only the merchant's registry, and publishes still move the `draft` dist-tag. The receipt shows the prerelease version and the review-cycle base.
- Prepare for public npm distribution. `reactiv app submit` no longer carries a hardcoded registry URL: it reads the merchant's submissions registry from the `@reactiv-submissions:registry` line in `.npmrc` and refuses to submit when that line is missing, is not https, or points at public npm. The published tarballs are now limited to an explicit whitelist (`bin/run` + `dist` for the CLI, `dist` for cli-ui), both packages declare their source repository, and every pack is inspected for stray files, secrets and unapproved hostnames before release.
- `reactiv app init` resolves the platform package under its new name, `@reactivapp/mobile` (was `@reactivapp/platform`). `reactiv app submit` reads the platform version from either name, so projects scaffolded before the rename keep submitting.

### Patch Changes

- Updated dependencies
  - @reactivapp/cli-ui@0.1.1

## 0.2.0

### Minor Changes

- `reactiv app submit`: packs `custom/` plus a `reactivPlus` manifest (appUuid, merchantSlug, platformVersion from the lockfile) as `@reactiv-submissions/<merchant-slug>` and publishes it to the submissions registry with dist-tag `draft`, printing a receipt. Pre-flight validation rejects a missing or contract-violating `custom/index` entry point, forbidden directories (node_modules/build/dist/Pods/.git/DerivedData) in the source tree or pack output, and submissions over the size cap (`--max-size-mb`, default 5). Resubmission auto-bumps the patch version from the registry's existing versions; published versions are immutable (registry-enforced, conflict surfaced cleanly). `--dry-run` runs the full pipeline without publishing.
- Validate the packed tarball artifact instead of the source tree: entry-point presence and export-contract checks run against `tar -tzf`/`tar -xzf` output of a real `npm pack`; export validation uses the TypeScript compiler API (parser-based, not regex); the root `custom/` symlink is rejected; the published bytes are the same tarball that was validated; sha256 is included in the receipt.
