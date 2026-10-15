# Command reference

Every command accepts `--help`. `reactiv --help` lists the top-level commands and the `app` topic; `reactiv app --help` lists the project commands.

The CLI runs on macOS and Linux with Node.js 24 or newer. `reactiv app run` needs macOS with Xcode and CocoaPods.

## Signing in

### `reactiv login`

Signs this machine in with the API key Reactiv issued to you.

```
reactiv login [--with-token] [--non-interactive]
```

| Flag | Effect |
| --- | --- |
| `--with-token` | Read the key from the first line of standard input instead of prompting (`reactiv login --with-token < key-file`). Refused on a terminal. |
| `--non-interactive` | Never prompt; fail if a prompt would be needed. |

What happens:

1. The key is checked against Reactiv's token service. The first time a key is used, the CLI prints the version, URL and checksum of the Reactiv Plus terms, asks you to read the document at that URL, and records your acceptance. This step needs a terminal.
2. The key is stored in `~/.config/reactiv/credentials.json` with mode `0600`. A previous login with a different key is replaced and its cached token discarded.
3. If you run it inside a project, the registry token in the project's `.npmrc` files is refreshed.

When `REACTIV_API_KEY` is set, `reactiv login` only validates it and prints which merchant it belongs to; nothing is written to disk. The CLI warns ahead of the key's expiry date.

### `reactiv logout`

Deletes the stored API key and the token cache. Inside a project it also removes the managed block from the project's `.npmrc` files. Tokens written into other projects are left alone; they expire on their own within 12 hours. If `REACTIV_API_KEY` is set in your shell, the command reminds you that it still authenticates `reactiv` commands.

### `reactiv whoami`

Prints the merchant and app UUID, the key label and holder, the key's expiry, the terms status, whether a cached registry token is valid and until when, and whether the login comes from the stored file or from `REACTIV_API_KEY`. The key itself is never printed. Inside a project it refreshes the registry token when needed.

## Project commands

### `reactiv app init`

Scaffolds a new project from the current `@reactivapp/app-template`.

```
reactiv app init [--name <app name>] [--path <dir>] [--bundle-id <id>] [--app-uuid <uuid>] [--skip-install] [--package-manager npm]
```

| Flag | Effect |
| --- | --- |
| `--name` | The app name shown in the app. Prompted for when omitted. Any text except quotes, backslashes and newlines; it is not used for file or package names. |
| `--app-uuid` | Optional. The app UUID; defaults to the app your login is provisioned for (`reactiv whoami` shows it) and is refused when it differs. |
| `--path` | Parent directory to scaffold into. Default: the current directory. |
| `--bundle-id` | iOS bundle identifier. Default: `com.reactiv.<slug without dashes>`. |
| `--skip-install` | Skip `npm install` in the root and in `app/`. |
| `--package-manager` | Only `npm` is supported today. |

What happens:

1. Your login decides the project identity: the merchant slug Reactiv provisioned for your key (lowercase letters, digits and dashes) becomes the folder name, the root package name and the default bundle identifier; the app UUID comes from the same login.
2. The current platform version and its pinned `react` and `react-native` versions are read from the registry, and the template is downloaded with npm so the transcript shows where it came from.
3. The template is expanded into `<path>/<slug>`, which must not exist or must be empty. A `git init` follows, and the CLI refuses to continue if the scaffold's `.gitignore` does not ignore `.npmrc`.
4. Dependencies are installed in the root and in `app/` with install scripts turned off. The CLI tells you which packages declared one so you can run `npm rebuild` in `app/` if the native build needs it.
5. An initial commit is created. If anything fails, what this run created is removed so you can fix the cause and run again.

### `reactiv app run ios`

Builds and runs the app on the iOS simulator. Run it from the project root.

```
reactiv app run ios [--skip-pods] [--simulator <name>]
```

| Flag | Effect |
| --- | --- |
| `--skip-pods` | Skip `pod install`. |
| `--simulator` | Simulator name to target, for example `"iPhone 16"`. Default: the booted iOS simulator when one is found; otherwise React Native's own choice. |

Before building, the CLI checks that `app/package.json` mirrors the library's dependencies, runs `pod install` in `app/ios`, checks that port 8081 is free, starts Metro in the background (log: `.reactiv-metro.log` in the project root) and runs `react-native run-ios` from `app/`. If the build fails, the Metro it started is stopped. This command does not refresh the registry token.

### `reactiv app upgrade`

Moves the project to another `@reactivapp/mobile` platform version.

```
reactiv app upgrade [--to <version>]
```

| Flag | Effect |
| --- | --- |
| `--to` | An exact version to move to. Required to move to an older version. Default: the version `reactiv app init` installs today. |

What happens:

1. The target version and its pinned `react` and `react-native` are resolved from the registry. Without `--to`, a target older than the project's current version is refused.
2. `package.json` (`peerDependencies`) and `app/package.json` (`dependencies`) are updated to the new trio and both are reinstalled with install scripts off.
3. The current template's toolchain files (`app/metro.config.js`, `app/babel.config.js`, `app/react-native.config.js`, `tsconfig.json`, `app/ios/Podfile`) are compared with yours. Differences are printed for you to apply by hand; the CLI does not overwrite them.
4. `npm run typecheck` runs at the project root.

The CLI never runs `pod install` for you; it prints the step. If the typecheck fails or the dependencies are out of sync afterwards, the change stays in place and the output ends with the rollback command (`reactiv app upgrade --to <previous version>`).

### `reactiv app submit`

Validates and packs the library at the project root and publishes it as a draft for Reactiv's review.

```
reactiv app submit [--dry-run] [--max-size-mb <n>]
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Run every check and pack the library, but publish nothing. The token service and the registry are still contacted, and the project's `.npmrc` token may be refreshed. |
| `--max-size-mb` | Maximum unpacked size in MB. Default 5. |

The checks are listed in [Project layout](project-layout.md#what-reactiv-app-submit-checks). The local ones run first; the CLI then contacts Reactiv's token service for a registry token and the submissions registry for the next draft version, scans the staged copy for credentials, packs `src/` and a generated `package.json` into a tarball, verifies the tarball's contents, and publishes it as `@reactiv-submissions/<slug>@<x.y.z>-draft.<N>` with the dist-tag `draft`. The receipt shows the version, the review-cycle base version, the app UUID, the declared dependencies, the registry and the tarball's sha256.

## Environment variables

| Variable | Effect |
| --- | --- |
| `REACTIV_API_KEY` | Use this key instead of the stored login. The key is never written to disk; registry tokens still go to the token cache and the project's `.npmrc`. Set it with `read -rs REACTIV_API_KEY && export REACTIV_API_KEY` so it stays out of your shell history, and in CI inject it from the pipeline's secret store. |
| `REACTIV_VENDING_API_URL` | Point the CLI at another token service, for tests and mocks. Must be an https URL without credentials, query or fragment; plain http is accepted only for `127.0.0.1` and `[::1]`. The CLI prints `using vending API <url>` whenever it is set. |
| `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` | Honoured for the locations below when set to absolute paths. |

## Files the CLI writes

| Path | Contents |
| --- | --- |
| `~/.config/reactiv/credentials.json` | Your API key and the merchant it belongs to. Mode `0600`. Removed by `reactiv logout`. |
| `~/.cache/reactiv/token-cache.json` | The current registry token and its expiry. Mode `0600`. |
| `<project>/.npmrc` and `<project>/app/.npmrc` | A managed block between `# >>> reactiv` and `# <<< reactiv` markers holding the registry URLs and the token, so plain `npm install` works for the token's lifetime. The CLI refuses to write it into a file git does not ignore (where git can tell), into a symlink, or into a file readable by others (it makes the file `0600` first). Your own lines outside the block are kept, except `@reactivapp` and `@reactiv-submissions` registry lines and token lines for the registry host shape, which the block replaces. |
| `<project>/.reactiv-metro.log` | Metro's output from `reactiv app run`. |

Registry tokens are short-lived (up to 12 hours). `reactiv login` and `reactiv whoami` run inside a project, and `app init`, `app upgrade` and `app submit`, refresh the token when it is missing or about to expire; `app run` and a login that only validates `REACTIV_API_KEY` do not. The CLI only accepts registry URLs from Reactiv's token service that are https and match the expected registry host shape; anything else is refused and nothing is written.
