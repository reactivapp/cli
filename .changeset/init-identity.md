---
'@reactivapp/cli': minor
---

`reactiv app init` takes the merchant slug and app UUID from your login: the slug names the folder, the package and the default bundle identifier, the app name is free text shown in the app, and `--app-uuid` is optional and refused when it differs from the login. Projects identify themselves by the root package name, with the app name as a fallback for projects scaffolded before this release. `reactiv app submit` also scans for Shopify access tokens, and every command refuses to run on Windows, not only `login`.
