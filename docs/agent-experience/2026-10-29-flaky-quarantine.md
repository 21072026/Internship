## 2026-10-29 — quarantine and reliability history for e2e (#1610)

- **Put a suite-wide test filter in `playwright.config.ts` (`grepInvert`), not in each
  workflow.** A CLI `--grep` still combines with the config's `grepInvert`, so
  `--grep @smoke` keeps excluding `@quarantine`. Checked with a throwaway spec and `--list`
  in all three modes (default, `E2E_QUARANTINE=only`, `--grep @smoke`). A probe spec under
  `BASE_URL=http://localhost:9` lists without booting a server.
- **Test a workflow's git plumbing locally against a bare repo.** Clone with `--depth 1`,
  point `origin` at a local `--bare` repo and run the step's shell twice: the first run
  creates the orphan `test-history` branch, the second appends to it. That surfaces the
  orphan and worktree mistakes that would otherwise show up only in the scheduled run.
- **Check what a "known flake" note claims against the latest run before acting on it.**
  The two specs CLAUDE.md listed were neither flaky nor logging the `reading 'user'` warning
  in the 2026-10-27 full run, so the paragraph was out of date, not a lead.
