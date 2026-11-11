# 2026-11-11 — Session length on interaction logs (#3521)

- **"Never guess" has a concrete trap here.** `meetingDurationMinutes()` returns
  60 for a meeting with no stored length — right for a calendar entry, wrong
  for a record of how long someone talked. The auto-log reads the raw
  `durationMinutes` column and stores NULL when it is empty; the e2e asserts it.
- **A new number next to a counter is a separate figure, not a new counter.**
  The dashboard sums `durationMinutes` with its own aggregate; the interaction
  count still counts rows (docs/last-contact.md), so nothing that reads "how
  many contacts" moves.
- **Chat buttons carry their payload as text.** The value is
  `"<minutes>:<interactionId>"`, decoded with an anchored regex and re-checked
  against the edit schema, so a forged value (`999:…`) is refused twice before
  `updateInteraction()` runs — and the authorization is `interactionAccess()`,
  the same as the note.
