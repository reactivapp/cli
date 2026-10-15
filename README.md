# Reactiv Plus CLI

[![npm version](https://img.shields.io/npm/v/@reactivapp/cli.svg)](https://www.npmjs.com/package/@reactivapp/cli)
[![CI](https://github.com/reactivapp/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/reactivapp/cli/actions/workflows/ci.yml)

`reactiv` is the command-line tool for building customizations for a Reactiv Plus mobile app. With it you:

- scaffold a project that wraps your TypeScript library in a runnable app shell,
- run the app on the iOS simulator and see your changes live,
- move the project to a newer platform release,
- submit a draft for Reactiv's review.

Reactiv builds and ships the app itself. You write the custom parts (components, screens, logic) in a small library, run it locally against the Reactiv platform, and submit it. Reactiv reviews, approves, and ships the next build with your code inside.

## Before you begin

- **A Mac with Xcode 26.1 or newer, an iOS 16 simulator and CocoaPods** to run the app. The CLI itself also works on Linux (log in, submit, upgrade). Windows is not supported yet.
- **Node.js 24 or newer** and npm. Get Node from [nodejs.org](https://nodejs.org/).
- **From Reactiv:** your personal API key (it starts with `rpk_`); it is provisioned for your app, so the CLI knows which app you are customizing. The key is shown to you once. Keep it out of chat, screenshots and git.

## Install

```bash
npm install -g @reactivapp/cli
reactiv --version
```

## Quick start

```bash
reactiv login                # paste your API key at the hidden prompt
reactiv app init             # scaffolds a folder named after your merchant and installs dependencies
cd <your-app-folder>
reactiv app run ios          # pod install, Metro, build, launch on the booted simulator
```

Edit the files in `src/`. The app refreshes as you save. When you are ready for review:

```bash
reactiv app submit --dry-run # every check, nothing published
reactiv app submit           # publishes a draft and prints a receipt
```

The [getting started guide](docs/getting-started.md) walks through each step, including adding packages and what happens after you submit.

## Commands

| Command | What it does |
| --- | --- |
| `reactiv login` | Signs in with your Reactiv API key and accepts the Reactiv Plus terms on first use |
| `reactiv logout` | Deletes the stored key and token cache and removes the registry token from the project |
| `reactiv whoami` | Shows the merchant, key and token state this machine is signed in as |
| `reactiv app init` | Scaffolds a new project from the current app template |
| `reactiv app run ios` | Builds and runs the app on the iOS simulator with Metro in the background |
| `reactiv app upgrade` | Moves the project to another platform version, reinstalls and runs the typecheck |
| `reactiv app submit` | Validates and packs your library, then publishes it as a draft for review |

`reactiv --help` lists the top-level commands and `reactiv app --help` the project commands. Every command accepts `--help`. The full reference, including flags, environment variables and the files the CLI writes, is in [docs/commands.md](docs/commands.md).

## Documentation

- [Getting started](docs/getting-started.md): install, sign in, create, run, add packages, submit, upgrade.
- [Command reference](docs/commands.md): every command, flag and environment variable.
- [Project layout](docs/project-layout.md): the library, the app shell, and the rules `reactiv app submit` enforces.
- [Troubleshooting](docs/troubleshooting.md): the messages you are most likely to meet and what to do.
- [Releasing](docs/releasing.md): how maintainers version and publish these packages.

## Getting help

Questions about your app, your API key or a review go to your Reactiv contact. For a problem with the CLI itself, [open an issue](https://github.com/reactivapp/cli/issues) with the command you ran, the relevant lines of output and your `reactiv --version`. Leave out your API key, registry tokens, the contents of `.npmrc`, your app UUID, merchant name, key labels and registry URLs; the issue form lists what to redact.

Security problems go to the address in [SECURITY.md](SECURITY.md), not to the issue tracker.

## Packages

| Package | Description |
| --- | --- |
| [`@reactivapp/cli`](packages/cli) | The `reactiv` command |
| [`@reactivapp/cli-ui`](packages/cli-ui) | The terminal output components the CLI renders with |

## Developing

```bash
pnpm install --ignore-scripts
pnpm build
node packages/cli/bin/run --help
```

`pnpm lint`, `pnpm typecheck` and `pnpm test` run the checks CI runs. Two more gates guard what this repository publishes: `pnpm pack:inspect` packs both packages and refuses anything outside the files whitelist, any credential pattern and any hostname that is not on the allowed list; `pnpm scan:internal` scans every tracked and untracked file, file name and symlink target, and with `--messages` and `--history` the commit messages, author and committer addresses, and every file version a range of commits introduced (merge and root commits included), for credentials (plain, base64-encoded or split across string constants), account identifiers, internal hostnames, repository links and addresses outside reviewed allowlists, and tracker references. CI also scans the full git history for credential values. All of it runs on every pull request.

Changes to a published package ship with a changeset (`pnpm changeset`). We are not taking external contributions yet; the issue tracker is the right place for bug reports and suggestions.

## License

The license for this repository is under review. Until it is replaced, [LICENSE](LICENSE) reserves all rights. Publishing the source here is for transparency: you can read exactly what the CLI does with your credentials and your code.
