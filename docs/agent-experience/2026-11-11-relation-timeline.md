# 2026-11-11 — Relation timeline completed (#1700)

- **Verify an "already shipped" issue against its own criteria before closing
  it.** #1700 looked done (#1702 shipped the route), but two criteria failed:
  the 404 for outsiders and two missing kinds. A criterion table on the issue
  made the gap reviewable instead of a judgement call.
- **Redact by not selecting.** The evaluation query `select`s no `scores`, so
  no viewer's payload can carry one; the mentee row additionally drops the
  comment and the author. An e2e asserts the raw response text, not the parsed
  entry, so a field added later cannot slip through unnoticed.
- **Subject-less `can(actor, 'program.read')` is the recurring PROGRAM_ADMIN
  bug** (#3582 journey, here the timeline). `relationSubject(relation)` is the
  one-line fix wherever a relation is already loaded.
