# 2026-10-27 — Chat apps schema (#1934)

- Before taking a story's console/UI task (#1958), check its dependency tasks exist on `main`:
  #1932's sub-tasks assumed `ChatWorkspace` (#1934) and the adapter (#1939), none of which had
  landed. Build the foundation as its own slice first, under its own issue.
- After pulling a `main` that carries #3224, `tsc` fails on `./scopes.generated` until
  `npm run i18n:scopes` (or `npm ci`) regenerates the manifest.
- Merge with `expectedHeadSha` — a mistyped PR number merges someone else's PR otherwise.
