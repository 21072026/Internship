# Agent Experience Log

A running retrospective for AI agents (Claude Code) working in this repo. **Standing
convention: at the end of each session, append a short dated entry here** with the
concrete, reusable lessons you learned — environment quirks, tooling limits, process
gotchas — so the next session starts smarter. Keep tactical, fast-changing tips here;
promote anything that becomes a durable rule into `CLAUDE.md`.

Newest entries on top.

---

## 2026-07-07 — Test tooling, a session-null fix, an email-in-history purge, and relicensing

**What shipped (all merged to `main`):**
- Non-functional test tooling: dependency-free stress/load harness (`scripts/stress-test.mjs`),
  a nightly cron workflow (`.github/workflows/stress.yml`) that emails on failure
  (`scripts/send-alert-email.mjs`), an XSS/injection e2e spec, and a `/api/health` probe (#506).
- `fix(mentor)`: the mentor dashboard used `session!.user.id`; a session revoked between the
  layout gate and the server render 500'd. Guarded with `if (!session?.user?.id) redirect(...)`
  like the portal page (#508). This was the real root cause of the `sign-out-all` e2e flake.
- Relicensed **MIT → AGPL-3.0-or-later** to keep the project open source while enabling a
  commercial/dual-licensing moat (#515).

**This remote environment ("Claude Code on the web") — hard limits, don't fight them:**
- **No `gh` CLI and no direct `api.github.com`.** GitHub is reachable *only* via the
  `mcp__github__*` tools. Direct `curl https://api.github.com/...` returns *"GitHub access is
  not enabled for this session."* (Note: `CLAUDE.md` mentions `gh` fallbacks — those apply to a
  *different* environment; ignore them here.)
- **The agent proxy blocks two write surfaces outright**, regardless of token: GitHub Actions
  **secrets** (`.../actions/secrets/...` → "not permitted through this proxy") and **repo
  settings** (`PATCH /repos/... {private:true}` → "Repository settings writes are not permitted").
  So *adding a secret* and *changing repo visibility* **must be done by the human** — don't
  promise to do them; give exact Settings-UI steps instead.
- Consequence for the nightly alert: since I can't create the `ALERT_EMAIL_TO` secret, the
  workflow defaults the recipient inline (`${{ secrets.ALERT_EMAIL_TO || '<maintainer>' }}`) so
  it works out of the box; a secret still overrides.

**GitHub MCP tooling gotchas:**
- `mcp__github__actions_list` returns a **huge** payload that overflows the tool-result budget.
  It saves to a file instead — parse that file with `python3` and filter by `head_sha`
  (branch/`per_page` filters are effectively ignored server-side). PR runs are keyed by the PR
  **head commit SHA**, not a merge SHA.
- `mcp__github__actions_get get_workflow_run` can return **stale/cached** data (frozen
  `updated_at`, status stuck `in_progress`). Cross-check completion with `get_job_logs`
  (`failed_only:true` → `failed_jobs:0`) *plus* a fresh `actions_list` conclusion; don't trust a
  single read.
- To read CI failures: `get_job_logs` with `failed_only:true` gives the failed job id, then
  `get_job_logs return_content:true tail_lines:~230` for the Playwright summary (the failing
  test list sits just above the run's cleanup logs).

**Branch protection / history rewrite (needed to purge a leaked email from history):**
- A force-push to `main` needs the maintainer to (1) enable *Allow force pushes* **and**
  temporarily disable (2) *Require a pull request* and (3) *Require status checks* — enabling
  only force-push isn't enough; the "require PR" rule still rejects any direct push.
- **Ref deletion is blocked** (`git push --delete` → HTTP 403 via the proxy), but ref *updates*
  are allowed — to neutralize a stale branch, force-push it to a clean commit instead of
  deleting it.
- History rewrite is **not** full erasure: the merged PR's diff page, existing **forks**, and
  GitHub's commit cache (reachable by old SHA until GC) still hold the content. Full removal
  needs making the repo private and/or a GitHub Support purge request. Say this plainly.

**Process:**
- Squash-merge means the designated branch's PR can already be **merged** with only the first
  commit; follow-up commits pushed afterward are separate. Rebase follow-ups onto the latest
  `main` and open a fresh PR (`git rebase --onto origin/main <old-base> <branch>`).
- The e2e suite is genuinely flaky (see `CLAUDE.md` for the known specs). Re-running only the
  failed jobs (`actions_run_trigger rerun_failed_jobs`) usually goes green; read the actual
  failure log before assuming your change broke something.
