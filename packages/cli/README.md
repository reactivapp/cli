# @reactivapp/cli

The `reactiv` command for developers building customizations for a Reactiv Plus mobile app: scaffold a project, run it on the iOS simulator, move it to a newer platform release, and submit it for Reactiv's review.

## Requirements

- Node.js 24 or newer and npm.
- macOS with Xcode, an iOS simulator and CocoaPods to run the app. Signing in, submitting and upgrading also work on Linux. Windows is not supported yet.
- An API key issued by Reactiv for your app. It is personal and shown to you once; keep it out of chat, screenshots and git.

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
reactiv app submit --dry-run # every check, nothing published
reactiv app submit           # publishes a draft and prints a receipt
```

## Commands

| Command | What it does |
| --- | --- |
| `reactiv login` | Signs in with your Reactiv API key |
| `reactiv logout` | Deletes the stored key and token cache and removes the registry token from the project |
| `reactiv whoami` | Shows the merchant, key and token state this machine is signed in as |
| `reactiv app init` | Scaffolds a new project from the current app template |
| `reactiv app run ios` | Builds and runs the app on the iOS simulator with Metro in the background |
| `reactiv app upgrade` | Moves the project to another platform version, reinstalls and runs the typecheck |
| `reactiv app submit` | Validates and packs your library, then publishes it as a draft for review |

Every command accepts `--help`.

## Documentation

- [Getting started](https://github.com/reactivapp/cli/blob/main/docs/getting-started.md)
- [Command reference](https://github.com/reactivapp/cli/blob/main/docs/commands.md)
- [Project layout and submission checks](https://github.com/reactivapp/cli/blob/main/docs/project-layout.md)
- [Troubleshooting](https://github.com/reactivapp/cli/blob/main/docs/troubleshooting.md)

## Support and security

Questions about your app, your API key or a review go to your Reactiv contact. For a problem with the CLI itself, [open an issue](https://github.com/reactivapp/cli/issues) and leave out keys, tokens, `.npmrc` contents and app identifiers. Security problems go to the address in [SECURITY.md](https://github.com/reactivapp/cli/blob/main/SECURITY.md).

## License

Under review; see [LICENSE](https://github.com/reactivapp/cli/blob/main/LICENSE).
