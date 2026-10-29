## 2026-10-28 — requisition fit score (#2042)

- **Extend the one matcher, don't fork it.** `requisitionMatchRule.ts` (#1401) decides who matches;
  the fit score rides on its `RequisitionMatch` as `fit` and only changes the sort. The alert cron
  now calls `matchCandidate()` per open requisition instead of its own skill/title loops, so the
  screen and the mail cannot disagree.
- **Make protected characteristics impossible, not just unused.** `FitCandidate` is its own narrow
  type (not `User`); the unit test passes extra fields (gender, birth date, name…) and asserts the
  score is identical.
- **No stage keys in a pure module.** `check:stage-keys` forbids naming canonical keys outside their
  owners; the stage dimension takes a 0…1 progress the caller derives from the org's resolved
  on-path stages (`stageProgressOf`).
- **Cold `next dev` compiles of role shells (/mentor, /company) can exceed the 60s test timeout here**
  — a `waitForURL` timeout on login is that, not the change; re-run with `--timeout=180000`.
