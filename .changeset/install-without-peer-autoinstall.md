---
'@reactivapp/cli': minor
---

One `npm install` for the whole project, and no more peers arriving uninvited.

The app template now lists `app/` as an npm workspace of the project root, so `reactiv app init` and `reactiv app upgrade` run a single `npm install` at the root that installs the library's dependencies and the shell's platform into one `node_modules`. Adding a package is one command at the root; `app/package.json` pins the platform and declares nothing else, and the sync check reports a library package that still appears there instead of asking you to mirror it. The installed-version, nested-copy, podspec and lockfile checks read the root tree and the root `package-lock.json`.

Every install also runs with `--legacy-peer-deps`, and the managed block the CLI writes into the project's `.npmrc` files sets `legacy-peer-deps=true` so your own `npm install` behaves the same way: npm no longer pulls in packages that a transitive dependency names as a peer. A fresh scaffold was failing with ERESOLVE when such a peer's newest release conflicted with the platform's `react-native`, even though nothing in the project used it.

Projects scaffolded before this release do not list the workspace; the CLI says so and asks for a fresh `reactiv app init`, into which `src/` moves unchanged. This release needs an app template that carries the workspace; an older template is refused at `init` with the same hint.
