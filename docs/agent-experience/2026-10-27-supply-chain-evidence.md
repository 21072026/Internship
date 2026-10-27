## 2026-10-27 — SBOM, licence inventory and the SLA-shaped audit gate (#2059)

- **Check the issue's "Claimed" comment for an orphaned branch before starting.** #2059 had a
  complete, never-PR'd commit on `claude/ultracode-queue-tasks-lw90u6-2059` from 2026-09-02;
  `git cherry-pick` onto current `main` plus five conflict resolutions was hours cheaper than
  rewriting it. `git log origin/main..FETCH_HEAD` on such a branch shows the base is ancient —
  cherry-pick the one commit, never merge the branch.
- **A step that wrote into the build context stopped reaching the image when the build became
  a matrix.** The old SBOM step wrote `public/sbom.cdx.json` in the same job as `docker build`;
  since #2166 the build runs in per-arch legs with their own checkout, so the file is now
  generated once in `prep`, uploaded, and each leg downloads it into `public/` before the build.
- **Re-run a gate against today's tree before tightening it.** The September verification said
  "0 blockers"; on 2026-10-27 `zod` 3.x had a new high (GHSA-mrhx-c7xc-m3w5, major-only fix), so
  the new gate would have merged red. The written SLA's path — a reasoned row in
  `docs/security-exceptions.md` with a deadline and an issue (#3210) — is what turned it green,
  not a looser threshold.
- `npm audit --json` works through the agent proxy; `api.github.com/advisories/*` does not
  (session is repo-scoped), so read advisory titles from the audit JSON's `via` entries.
- `/sbom.cdx.json` has a dot, so `src/middleware.ts`'s matcher skips it and Next serves it
  from `public/` as a plain static file with no auth — verified with `curl` on `next dev`.
