# Troubleshooting

The messages you are most likely to meet, and what to do.

## `not a Reactiv Plus project (reactiv.conf.js not found)`

Run the command from the project root, the folder that holds `reactiv.conf.js`.

## `Logged in as <merchant>, but this project belongs to <other merchant>`

The key you are using belongs to a different app. Log in with the key for this app, or switch projects.

## `Terms version … must be accepted interactively once`

Run `reactiv login` on a terminal. The CLI shows the terms and records your acceptance; `REACTIV_API_KEY` and `--non-interactive` cannot do that step.

## `Your Reactiv API key expired` or `was revoked`

Ask Reactiv for a new key, then run `reactiv login`.

## `Not logged in`

Run `reactiv login` with the API key Reactiv issued to your team.

## `the registry rejected the token during npm install`

Run `reactiv whoami` to check your login, then `reactiv login` if needed, and re-run the command.

## `.npmrc is not ignored by git`

Add `.npmrc` (no leading slash) to `.gitignore` so both the root and `app/` copies are ignored. If a copy is already tracked, untrack it with `git rm --cached .npmrc` or `git rm --cached app/.npmrc`, whichever the message names. The CLI will not write a registry token into a file git could commit.

## `package.json dependencies must be exact versions`

Reinstall the package with `--save-exact`, at the root and in `app/`.

## `src/ imports packages that package.json does not declare`

Install the named package at the root and in `app/`. The message shows the exact command.

## `package.json dependencies include packages the platform provides`

Remove the named package from `dependencies`; it is supplied by the platform. The message tells you where it belongs.

## `app/package.json dependencies are out of sync with the library's package.json`

Make both manifests declare the same packages at the same versions, then run `npm install` in `app/`. The message lists each difference.

## `app/node_modules does not hold the declared versions`

Run `npm install` in `app/`.

## `entry point must export CustomCompositions and registerCustomComponents`

Keep both named exports in `src/index.ts`. The scaffold's samples show the shape.

## `package.json dependencies include libraries that require native project changes`

That library needs changes to the native iOS project, which a customization cannot carry. Pick a pure JavaScript alternative or ask Reactiv.

## `possible credentials found in the submission`

Treat each finding as compromised: rotate it with its provider, remove it from the source, and submit again. Removing it alone is not enough if it was ever committed or shared.

## `port 8081 is already in use`

Another Metro is running on this machine. Stop it, then run `reactiv app run ios` again.

## `Reactiv's token service is unreachable`

Try again in a few minutes. When the service answered, the message includes a request id; include it when you report the problem.

## `Reactiv's token service no longer serves this CLI's API version`

Update the CLI: `npm install -g @reactivapp/cli@latest`.

## The upgrade applied but the typecheck fails

The change stays in place. Fix the errors the typecheck printed, or roll back with the command at the end of the output.
