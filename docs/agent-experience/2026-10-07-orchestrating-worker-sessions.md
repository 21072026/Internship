# 2026-10-07 — orchestrating worker sessions, and the safeguarding PR (#2056)

Lessons from the root backlog session that drove four worker sessions and shipped
#2051, #2054 and #2056.

- **Worker sessions share one 5-hour quota with you.** Five sessions at high
  effort exhausted it twice in a day; every worker stalled with its PR half-done
  and sat idle for hours after the reset, because nothing wakes an idle session.
  What worked: after the reset, wake each one with `create_trigger`
  (`persistent_session_id`, `run_once_at` ~2 min out) and a prompt that names its
  exact open PR and its state (dirty / which check is red), and say **"in-flight
  only, do not start a new item"** until everything open has merged. Then hand
  out the next items in **disjoint lanes** (one area per session, an ordered
  candidate list each) so two sessions never claim the same issue.
- **`get_session` / `list_sessions(mine)` is the status board.** `status_bucket`
  FAILED + "session limit" means quota, not a broken task; `task_summary` tells
  you what it was doing. Check it from your own scheduled check-in rather than
  waiting for events — an idle session emits none.
- **A run that never schedules its aggregate job cannot be re-run.** #2876's E2E
  run concluded `failure` with every shard green but the required "Playwright
  smoke" aggregate job never created; `rerun-failed-jobs` answered 403 "cannot be
  retried". An empty commit is forbidden, so the fix was a real one: rebase onto
  the (moved) main and push, which gave CI a fresh run.
- **Adjacent i18n/registry inserts conflict on every merge.** Two PRs that both
  add a block before the same anchor (`orgWizard` in dictionaries.ts, the tail of
  `AI_TASKS`) conflict; keep both sides and check the closing `},` — a resolution
  that drops it type-checks nowhere else but tsc.
- **`check:demo-fidelity` reads `process.env.DATABASE_URL` only** — no `.env`
  loading. In a fresh worktree run checks with `set -a; . ./.env; set +a` first,
  or it refuses with "does not look local".
- **A fresh worktree has no `node_modules`.** Symlink an installed sibling
  worktree's (`ln -s ../practice/node_modules node_modules`); the main checkout's
  may not be installed, and `npx prisma` then silently fetches the latest major
  (8.x rc) instead of the pinned 5.x.
- **`mobile-layout-coverage` has two lists that look alike.** A new admin page
  goes into the group whose test renders it (`OPERATIONS` …), not into
  `AUDITED_ELSEWHERE`, which means "another spec covers it".
