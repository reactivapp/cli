# Project layout

`reactiv app init` creates one folder with two parts.

```
<your-app>/
├── reactiv.conf.js        app identity: appName and appUuid
├── package.json           the library: what you submit
├── src/
│   └── index.ts           must export CustomCompositions and registerCustomComponents
├── tsconfig.json
├── .npmrc                 generated, git-ignored, never committed
└── app/                   the runnable shell, never submitted
    ├── package.json       mirrors the library's dependencies and pins the platform
    ├── package-lock.json
    ├── ios/
    ├── metro.config.js
    ├── babel.config.js
    ├── react-native.config.js
    └── .npmrc             generated, git-ignored
```

## The library (root)

The root `package.json` and `src/` are the submission. The manifest declares:

- `main` or `react-native`: the entry point, `src/index.ts`, `src/index.tsx` or `src/index.js`. When both fields are set they must name the same file.
- `files`: `["src"]`.
- `dependencies`: packages your code imports, each with an exact version.
- `peerDependencies`: `@reactivapp/mobile`, `react` and `react-native` at the exact versions the app shell runs, plus any package the platform supplies that your code imports.

`src/index.ts` must export `CustomCompositions` and `registerCustomComponents` as named values. Type-only and default exports do not count. Everything your code imports by relative path must live under `src/`.

## The app shell (`app/`)

`app/` wraps the library in a real React Native app so you can run it. It depends on `@reactivapp/mobile`, the Reactiv platform package, at a pinned version, and delegates its Metro, Babel and React Native configuration to the platform's toolchain. It is never submitted. Its `package.json` must list the same dependencies as the library at the same versions, because native modules autolink from there.

After the first install, the toolchain files are yours. `reactiv app upgrade` tells you when the current template's versions differ.

## What `reactiv app submit` checks

The checks run in this order. Steps 1 to 8 finish before the CLI contacts Reactiv; it then obtains a registry token (at which point the signed-in key must belong to this app's UUID and slug) and the next draft version, and steps 9 and 10 run on the staged copy before the publish.

1. **Project identity.** `reactiv.conf.js` exports `appUuid` and `appName`, and the name produces a usable slug.
2. **Layout.** `app/package.json` exists and the root manifest has a `files: ["src"]` entry and an entry point inside `src/`.
3. **Dependencies in sync.** The library's `dependencies` appear in `app/package.json` at the same versions; packages the platform provides are not in the library's `dependencies`; the platform trio is pinned identically in both; `app/node_modules` holds what the manifests declare, without duplicate copies.
4. **Submittable dependencies.** Every dependency is an exact registry version (no ranges, tags, URLs, git links or local paths); nothing in the `@reactivapp` or `@reactiv-submissions` scopes; no `overrides` in `app/package.json`; `app/package-lock.json` exists and records the installed platform version.
5. **Native integration.** No dependency needs changes to the native project: a short list of known libraries with app-level setup is refused, and the CocoaPods podspecs of your direct dependencies are checked for build hooks. Gradle changes, Info.plist usage descriptions and entitlements are not detected here and are rejected at Reactiv's review instead.
6. **Forbidden content.** No `node_modules`, `build`, `dist`, `Pods`, `.git` or `DerivedData` under `src/`, and `src/` is not a symlink.
7. **Imports.** Every bare import in `src/` names a declared dependency or a platform package by its public entry, and every relative import stays inside `src/`. Node built-ins, package.json `imports` aliases, absolute paths and computed import specifiers are refused. Whether a relative import's target exists is not checked here; a missing file fails your typecheck and Reactiv's build.
8. **`.npmrc` ignored.** The project's `.npmrc` files are git-ignored.
9. **Credential scan.** The staged submission holds no AWS keys, GitHub or npm tokens, PEM private keys or Reactiv API keys.
10. **The tarball itself.** The entry point and the files it re-exports the two required names from are in the packed tarball, and the unpacked size is within the cap.

Each failure names the file and the exact edit. `--dry-run` runs all of them.

## Versions

Drafts are published as `@reactiv-submissions/<slug>@<x.y.z>-draft.<N>`. `<x.y.z>` is the review cycle: the next patch after the highest version Reactiv has approved for your app, or `0.1.0` for the first one. `<N>` counts your submits within that cycle. Published versions are immutable; a resubmit always gets a new number.
