# 2026-10-27 — hiring lifecycle events on the bus (#1998)

- **Grep the "REGISTERED but not dispatched" comments first.** Before `emit()` existed,
  every hiring route left a comment where its event belonged (`grep -rn "REGISTERED in
  WEBHOOK_EVENTS" src`). They are the work list — and the comment is replaced by the call.
- **"Fires on every writer" includes the second writer of a *description*.**
  `interview_panel.completed` says "every interviewer scored, *or an admin closed it*",
  but only the score route raised it; the close route needed it too, guarded so a panel
  already complete through scores is not announced twice.
- `*.unit.spec.ts` run without the dev server: `BASE_URL=http://localhost:9 npx playwright test …`.
