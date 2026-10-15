---
'@reactivapp/cli-ui': patch
'@reactivapp/cli': patch
---

Banners now fit the terminal: they use the destination stream's width, up to 72 columns, instead of a fixed 72 columns that wrapped in narrower windows. The `@reactivapp/cli` package README now states the Xcode 26.1 requirement for running the app.
