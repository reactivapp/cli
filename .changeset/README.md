# Changesets

Every pull request that changes what `@reactivapp/cli` or `@reactivapp/cli-ui` does ships with a changeset: a short Markdown file in this directory that names the package, the semver bump and a one-line summary. Create one with:

```bash
pnpm changeset
```

Merging to `main` collects pending changesets into a "Version Packages" pull request. Merging that pull request bumps the versions and writes the changelog entries. Publishing to npm is a separate, human-approved step described in [docs/releasing.md](../docs/releasing.md).
