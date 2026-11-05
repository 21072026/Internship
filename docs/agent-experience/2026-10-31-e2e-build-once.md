# 2026-10-31 — Build once for the e2e gate (#3509)

- **`.next` without `.next/cache` is ~25 MB gzipped** (the cache alone is ~5.7 GB
  locally). Sharing a build between jobs costs far less than rebuilding it.
- **upload-artifact skips hidden paths by default**, and `.next` is one. Upload a
  tarball instead; it also keeps modes and layout exactly.
- **Check an artifact build against the commit before you trust it.** A sha
  stamped into the archive is a single-line check that fails loudly.
- **Most env is read at runtime, but some is baked in at build time.**
  `NEXTAUTH_URL` and the Playwright webServer env are read when the server starts,
  so one build serves both the :3000 and the :3010 (isolation) server. What
  `next.config.js` reads (CSP, `NEXT_PUBLIC_*`, `env:`) is baked into the build,
  so those values must be the same in every job that shares it.
- **Test a moved build locally:** pack `.next`, move the original aside, extract
  the tarball, then `CI=1 npx playwright test …` starts `next start` on what came
  out of the tarball.
- **`e2e-full.yml`'s build needs full git history** (`fetch-depth: 0`). The release
  dates are baked into the build, so the shared build job checks out with full
  history. The isolation job used to build from a shallow clone and so had undated
  releases; now it uses the same build as the shards.
- **A branch `workflow_dispatch` of `e2e-full.yml` is a real run.** It appends to the
  `test-history` branch and touches the `ci-alert` issue like a scheduled one.
