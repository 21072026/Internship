## 2026-10-27 — porting a two-month-old assurance PR (#2031)

- **An orphaned documentation commit is stale in its facts even when it cherry-picks
  cleanly.** #2031's September commit applied without a conflict, but its "open findings"
  (#1535/#1546/#1539) had all closed, the hostnames were the retired Plesk-era ones, and a
  dozen questionnaire rows said ❌ for things that have shipped since (recovery codes, HIBP,
  shared rate-limit store, secrets runbook, SBOM, VPAT, subprocessor register, audit stream).
  For trust documents a wrong "no" is as bad as a wrong "yes": re-check every issue number
  (`gh api repos/<o>/<r>/issues/N --jq .state` works inside the repo scope) and every
  ✅/❌ against the code before merging.
- **`get_sub_issues` on a big epic overflows the MCP result**; `gh api
  repos/<o>/<r>/issues/N/sub_issues --jq '.[] | "\(.number) \(.state)"'` gives the same
  answer in one line per child.
- **"Blocks a merge" means a required check.** On `main` only `Playwright smoke` and
  `Forbidden terms (PR)` are required; `ci.yml` and `security-audit.yml` fail the run but do
  not block. Questionnaire and pen-test docs must say exactly that.
- **`pkill -f "next dev"` in the same Bash call kills that call's own shell** (exit 144, the
  rest of the command never runs) — the pattern matches the command line. Stop the dev server
  in a separate call.
