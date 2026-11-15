# 2026-11-13 — PR smoke gate narrowed to a core scope

- The @smoke tag had drifted again: 768 tests (384 browser + 384 unit) against the ~107
  pruned in #2811. Each smoke shard spent ~7 min in Playwright, the critical path of the gate.
- Instead of untagging ~250 files (a conflict magnet for parallel PRs), the PR gate now
  passes a file list to Playwright (`E2E_SCOPE=core` in `.github/workflows/e2e.yml`).
  One file, one revert switch: repo variable `E2E_SMOKE_SCOPE=full`.
- `npx playwright test <files> --grep @smoke --shard=1/2 --list` works without a DB or a
  server — the quickest way to measure a gate change locally.
