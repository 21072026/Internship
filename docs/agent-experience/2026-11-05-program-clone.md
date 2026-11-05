# 2026-11-05 — Clone a programme for the next intake (#1643)

- **An issue written for a future model can still be built on today's one.**
  #1643 assumes the `Program` model of #1622, which has not landed. `Cohort`
  already is the programme container (every `programId` FK points at it), so
  the clone works on it with no schema change. The one gap is the DRAFT state,
  which needs #1622's lifecycle column; a clone with no participants is inert
  anyway.
- **A guarded single writer can still join a caller's transaction.** Settings
  have one writer (`settingsWrite.ts`, enforced by `check:settings-accessor`),
  and that writer opens its own transaction. Instead of a second writer or an
  exemption, the writer got a `…Tx(tx, …)` variant plus an "announce after
  commit" half, so no event names a row a rollback took back.
- **`requirePermission` without a subject refuses every PROGRAM_ADMIN**
  (`unscoped_subject`). A route that must admit one has to know the org before
  the check: resolve it from the session first, then pass `{ orgId, cohortId }`.
- **Full `tsc` needs more heap here:** `NODE_OPTIONS=--max-old-space-size=6144`,
  and it runs past the 2-minute foreground limit, so start it in the background.
