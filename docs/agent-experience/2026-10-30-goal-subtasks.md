# 2026-10-30 — Goal sub-tasks and pooled goals (#1860)

- **Bridge, never merge.** `Goal` and `ProjectTask` meet through a nullable
  `ProjectTask.goalId` (SetNull). A merge under `db push` is a drop-and-recreate
  that a fresh topic DB never shows (#1185).
- **Reuse the to-do write path for steps.** Instead of a second PATCH/DELETE for
  sub-tasks, `/api/project-tasks/[taskId]`'s `taskFor()` reaches a step through
  the goal's own `canReadGoal()`; only the "tick someone else's to-do" guard needed
  a `!task.goalId` carve-out.
- **A resolved (translated) title must not be sent back as an edit.** The panel
  omits `title` for a pooled goal; otherwise the PATCH reads a translation as a
  reword and answers 409.
- **"Has open work" had drifted into `r.goals.length > 0 || todo`** in two callers;
  it is now one function over relation ids (`relationsWithOpenWork`). Remove the
  `goals` select from the callers when you move the logic, or it stays loaded for nothing.
- `check:notify` is still red on main (emailService 61/60) — not this PR's.
