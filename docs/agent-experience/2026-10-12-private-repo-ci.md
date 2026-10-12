## 2026-10-12 — the repository went private, and CI broke in three places (#2903, #2902)

- **When several unrelated PRs go red at once, check the repository before the diff.**
  `gh repo view --json visibility` said `PRIVATE`. That one flip explained a red CodeQL on
  every PR, a heap OOM in `next build`, and the missing branch protection. #2902 had already
  spent a round guessing whether its emoji change caused the OOM.
- **On a private repo, CodeQL runs and then fails at the upload.** The log ends with
  `Advanced Security must be enabled for this repository to use code scanning.` The analysis
  itself is fine, so don't debug the queries. The fix is to buy GitHub Code Security or remove
  the workflow. We removed `.github/workflows/codeql.yml`, and its history is in git.
- **Private repos get smaller hosted runners, and Node's default heap follows the RAM.** The
  type-check phase of `next build` died at ~2 GiB with `Ineffective mark-compacts near heap
  limit`. Every build step (CI, both e2e workflows, the Dockerfile builder) now sets
  `NODE_OPTIONS=--max-old-space-size=4096`. Set it on the build step only, never at runtime or
  in `package.json`.
- **A private repo on the Free plan has no branch protection.** `gh api
  repos/<o>/<r>/branches/main/protection/required_status_checks` answers `403 Upgrade to GitHub
  Pro or make this repository public`. "Required check" in `CLAUDE.md` is now a convention, not
  a gate, and nothing stops a red merge. Check that CI is green yourself before merging.
- **Actions minutes are metered now.** Several workflow headers and `CLAUDE.md` still say "the
  repo is public, hosted runners are free". That was true until 2026-10, and it is the premise
  behind the 4×/day full e2e and the two-arch image build on every PR push.
