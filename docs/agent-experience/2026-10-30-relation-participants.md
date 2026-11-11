# 2026-10-30 — Relation participants, data foundation (#1804, slice 1)

- **Mirror rows must not grant access.** The issue asks for a seat row per scalar of every
  relation. But a mentor can be corrected IN PLACE (#2289's no-history path), which would leave
  the old mentor's seat behind as a live grant. `isPrimaryPair` marks the mirror rows and every
  access read ignores them — the scalars stay the pair's truth. Ask "what writes the thing this
  row mirrors?" before letting a mirror authorize anything.
- **An invariant's single reader is the place to widen it.** One-active-mentor lives in
  `findActiveMentorship()`; adding an `OR` on open MENTEE seats there extended the rule to every
  one of its eight write paths at once. `scripts/test/active-mentorship.test.mjs` pins the exact
  `where` shape, so the change and the test move together.
- **Cascades on a new child table bite in `mergeUsers`:** the duplicate is deleted at the end, and
  its seats would go with it. Move them first (and fold into an existing seat on the unique).
- `infra/server/topic-deploy.sh` runs its own short list of backfills, separate from the prod
  registry — add a new one in both places.
