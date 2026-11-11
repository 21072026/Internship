# 2026-10-31 — CI concurrency audit

- **A PR-triggered workflow without `concurrency` keeps every stale run alive.** With ~20 PRs in
  flight the hosted-runner queue, not the tests, set the merge pace. Audit with a one-liner that
  YAML-loads each `.github/workflows/*.yml` and prints `on` keys + `concurrency` (PyYAML parses
  `on:` as the boolean key `True`).
- **Cancel PR runs only:** `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. A
  bare `true` also cancels main pushes and schedules (codeql/security-audit had that). Workflows
  with a `workflow_dispatch` release action (mobile EAS) key the group on
  `github.event.pull_request.number || github.run_id`, so a manual run is never cancelled.
- **One PR push compiles Next.js ~7 times** (ci build, 3 e2e matrix jobs + the isolation gate,
  amd64 + arm64 topic images). Reported, not refactored: a single build job handing `.next` to the
  shards as an artifact is the obvious next lever.
- `actionlint` is not in the container, and fetching its release binary is refused by the
  sandbox's code-from-external rule — validate by YAML-loading instead.
