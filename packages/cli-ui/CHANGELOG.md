# @reactivapp/cli-ui

## 0.1.3

### Patch Changes

- 8ee052c: Banners now fit the terminal: they use the destination stream's width, up to 72 columns, instead of a fixed 72 columns that wrapped in narrower windows. The `@reactivapp/cli` package README now states the Xcode 26.1 requirement for running the app.

## 0.1.2

### Patch Changes

- 1d4950f: The CLI is now developed and published from the public repository at github.com/reactivapp/cli. Both packages point their `repository`, `homepage` and `bugs` fields there and ship a README.

## 0.1.1

### Patch Changes

- Prepare for public npm distribution: the published tarball is limited to `dist`, the package declares its source repository, and every pack is inspected for stray files, secrets and unapproved hostnames before release.
