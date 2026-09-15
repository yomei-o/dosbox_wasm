# Pending workflows

These are ordinary GitHub Actions workflows. They live here rather than in
`.github/workflows/` only because the token used to push did not carry the
`workflow` scope, and GitHub refuses such a push.

To enable them:

```sh
gh auth refresh -h github.com -s workflow
git mv .github/workflows-pending/build.yml .github/workflows/build.yml
git mv .github/workflows-pending/pages.yml .github/workflows/pages.yml
git commit -m "Enable workflows" && git push
```

`pages.yml` is only needed if Settings -> Pages -> Source is set to
"GitHub Actions". Serving the branch root ("Deploy from a branch", `main`, `/`)
works just as well and needs no workflow at all.
