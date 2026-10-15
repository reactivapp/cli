# Security policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in the Reactiv Plus CLI or in `@reactivapp/cli-ui`, email **security@reactiv.ai**. Please do not open a public GitHub issue for security problems.

Include what you can of the following:

- The package and version (`reactiv --version`)
- Steps to reproduce, or a proof of concept
- The impact you believe it has

We acknowledge reports within five business days and keep you informed while we work on a fix. We ask that you give us reasonable time to address the issue before any public disclosure.

There is no bug bounty program at this time.

## Supported versions

Security fixes are released for the latest published version of each package. Update with `npm install -g @reactivapp/cli@latest`; `@reactivapp/cli-ui` is a dependency of the CLI and updates with it.

## What the CLI does with your credentials

- Your Reactiv API key is stored in `~/.config/reactiv/credentials.json` with mode `0600`, or read from `REACTIV_API_KEY` and never written to disk.
- By default the key is sent only to Reactiv's token service over HTTPS. `REACTIV_VENDING_API_URL` changes that destination (https, or plain http on a loopback address for local mocks); set it only for a service you trust with your key. Short-lived registry tokens the service returns are cached in `~/.cache/reactiv/token-cache.json` (mode `0600`) and written into a managed block in your project's `.npmrc`. Inside a git repository the CLI writes that block only when `.npmrc` is git-ignored. Outside one it writes it anyway (a scaffolded project is always a repository with `.npmrc` ignored), so if you later run `git init` in such a folder, add `.npmrc` to `.gitignore` before staging anything.
- The CLI redacts API keys in its own output and errors, its tests assert that tokens never appear in command output, and `reactiv app submit` scans your submission for credential patterns before anything is published.

If you notice behaviour that contradicts this, report it as a vulnerability.
