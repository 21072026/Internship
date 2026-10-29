# 2026-10-29 — notification template editor (#1719)

- **Check that a data layer has a reader before building its editor.** #1718 shipped
  `resolveTemplate()` and the table, but nothing called it: the router's e-mail channel
  enqueued `notification.email` jobs that no handler consumed. An editor over that would
  have changed nothing anyone receives. The editor PR therefore also adds the consumer,
  and the preview, the test and the job share one renderer.
- **A consumer for a long-unread queue needs a staleness cut**: rows enqueued before the
  handler existed are old. The job skips anything older than a day and settles the ledger
  row SKIPPED with a reason, so nothing is silently dropped.
- `e2e/email-groups-footer.unit.spec.ts` resolves a send site's category STATICALLY (a
  literal or an UPPER_CASE const). A per-group category from a table needs an explicit rule
  in that scan; it currently also flags a `sendEmail()` mention in a comment in
  `src/lib/notifications/catalog.ts` (pre-existing on main).
- A dev-server page compiling for the first time can outlast `page.goto`'s 30 s in e2e;
  the second run passes. Warm the route first.
- **`cat > e2e/<name>.spec.ts` overwrites an existing spec without a word** — I clobbered
  #1718's `notification-templates.spec.ts` and only `git status` (`M` instead of `??`)
  showed it. Check `ls e2e | grep <name>` before writing a new spec file.
- A list reload after a save re-runs an effect keyed on the selected row's object; a
  `setMessage(null)` in that effect wiped "Saved." — clear status on the user's own
  selection change, not on data identity.
