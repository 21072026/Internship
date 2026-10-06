## 2026-10-06 — agent-experience as one file per session (#2804)

- **When a PR has no check runs at all, check its mergeability before anything else.** GitHub
  runs no `pull_request` workflow on a conflicted PR. `get_check_runs` returning `total_count: 0`
  with `mergeable_state: unknown` was a conflict three times in a row, always in the old shared
  `docs/agent-experience.md`.
- **`merge=union` in `.gitattributes` does not help on GitHub.** GitHub's mergeability check and
  its merge button ignore merge drivers, so union only resolves local merges. The structural fix
  is the one `releases/unreleased/` already uses: one new file per change, no shared lines.
