# Getting started

This guide takes you from an empty folder to a submitted draft. Read it once top to bottom; afterwards each section stands on its own.

## How it works

1. **Install** the `reactiv` CLI and log in with the API key Reactiv gave you.
2. **Create** a project. You get a library for your code and a runnable app shell around it.
3. **Build** in `src/`. Run the app on the iOS simulator and see changes as you save.
4. **Submit** a draft and tell your Reactiv contact which version is ready.
5. **Review.** Reactiv replies with feedback. Fix, resubmit, repeat until approved.
6. **Ship.** Reactiv publishes the approved version and builds the app.

## Before you start

- A Mac with Xcode 26.1 or newer, at least one iOS simulator, and CocoaPods: `gem install cocoapods`, or `bundle install` in `app/` after scaffolding for the version the project pins. The CLI also runs on Linux for everything except `reactiv app run`. Windows is not supported.
- Node.js 24 or newer, and npm.
- Git, with your name and email configured: the scaffold makes an initial commit.
- From Reactiv: your API key (starts with `rpk_`). It is provisioned for your app; the CLI takes the app UUID and merchant name from it.

Your API key is personal and shown to you once. Keep it out of chat, screenshots and git. If you lose it, ask Reactiv for a new one.

## 1. Install the CLI

```bash
npm install -g @reactivapp/cli
reactiv --version
```

## 2. Log in

```bash
reactiv login
```

Paste your API key when asked; the input is hidden. You will see `Logged in as <merchant> (key <label>).` and you stay logged in on this machine until you run `reactiv logout` or the key expires.

- `reactiv whoami` shows which merchant and key you are using and when the key expires.
- `reactiv logout` removes the key and tokens from this machine.

Using the CLI in CI or a script? Put the key in the environment instead of logging in; the CLI then never writes it to disk:

```bash
read -rs REACTIV_API_KEY && export REACTIV_API_KEY
reactiv app submit --dry-run
```

The key must have accepted the current terms once, through an interactive `reactiv login`, before it can be used this way.

## 3. Create your project

```bash
reactiv app init
cd <your-app-folder>
```

The CLI asks nothing: it takes the merchant slug and app UUID from your login, resolves the current platform version, downloads the app template and installs dependencies. The folder, the package and the app name in the shell are all the merchant slug, for example `acme`. The project has two parts:

- **The root is your library.** This is what you submit. Your code lives in `src/`, and `package.json` declares the packages you add.
- **`app/` is the runnable shell.** It wraps your library in a real app so you can run it. It is never submitted, and the platform version it runs is pinned for you.

Two rules about `src/`:

- `src/index.ts` must export `CustomCompositions` and `registerCustomComponents`. The project comes with working samples of both. Start from those.
- Everything you import from your own code must live under `src/`.

`reactiv.conf.js` holds your app identity (name and UUID). `.env` and `.npmrc` are generated and git-ignored; never commit them. [Project layout](project-layout.md) has the details.

## 4. Run the app

```bash
reactiv app run ios
```

This installs pods, starts Metro, and launches the app on the booted simulator (or pick one with `--simulator "iPhone 16"`). Edit files in `src/` and the app refreshes. Metro keeps running in the background; its log is in `.reactiv-metro.log`.

- Already have pods installed? Add `--skip-pods`.
- If port 8081 is busy, another Metro is running. Stop it first; the CLI refuses to start next to a Metro that would serve another project's bundle.
- Type errors: run `npm run typecheck` at the project root. It must pass before you submit.

## 5. Adding packages

Install at the project root, always with an exact version:

```bash
npm install --save-exact date-fns@4.1.0
```

`app/` is an npm workspace of the root, so the one install serves the library and the shell.

`reactiv app submit` checks that:

- every package `src/` imports is declared in the root `package.json`, with an exact version (no `^`, `~`, tags, URLs or git links);
- `app/package.json` declares nothing but the platform; your packages live in the root `package.json`, so what you ran is what you submit;
- nothing the platform already provides is listed: `react`, `react-native` and the Reactiv packages are supplied for you and stay in `peerDependencies`;
- no dependency needs changes to the native iOS project, as far as the CLI can tell from a list of known libraries and your direct dependencies' CocoaPods podspecs. Pure JavaScript and TypeScript libraries are fine; a library with its own native setup cannot ship inside a customization, so ask Reactiv if you need one.

Reactiv's review additionally expects published packages from the public npm registry. The error messages name the exact edit when a check fails.

## 6. Submit for review

First, a dry run. It performs every check and packs your library without publishing it (it still contacts Reactiv's token service and your submissions registry):

```bash
reactiv app submit --dry-run
```

When it passes, submit for real:

```bash
reactiv app submit
```

You get a receipt with the version, for example `@reactiv-submissions/<slug>@0.2.0-draft.3`, and a sha256 of the packed library. The CLI picks the version for you: `0.2.0` is the review cycle, `draft.3` counts your attempts in it. Drafts are permanent; each submit creates a new one.

Tell your Reactiv contact which version is ready, with the sha256 from the receipt and a line or two on what changed. Review feedback comes back per item; fix, submit again, and name the version it replaces. On approval, Reactiv tells you the official version, and your next submit starts the next review cycle.

## 7. Keep the platform up to date

```bash
reactiv app upgrade                 # move to the current platform release
reactiv app upgrade --to 2610.9.3   # or pick a version
```

The CLI updates the platform version in both `package.json` files, reinstalls once at the root, and runs your typecheck. Then run `cd app/ios && pod install`. If the project no longer checks clean, the change stays in place and the output ends with the exact command to roll back.

Some toolchain files (Metro, Babel, tsconfig, Podfile) are yours after the first install. When the current template differs, the CLI prints the new content and leaves the edit to you.

## Where to go next

- [Command reference](commands.md) for every flag and environment variable.
- [Project layout](project-layout.md) for the rules behind the checks.
- [Troubleshooting](troubleshooting.md) when a message stops you.
