# 2026-10-31 — Org attributes as a matching dimension (#3424)

- **Follow the `customField:<key>` family for any per-org dimension.** A prefixed
  dimension key, a bulk loader with an injectable db (so the unit test can count
  queries), a save-route refusal for keys the org does not have, and the editor
  offering only the org's own entries — #1803 already solved each of these.
- **Hook both bulk loaders into one `withMatchExtras()` in `pool.ts`**: every
  loader (pool, mentees, the scored pair) gets the same attachments, so suggest,
  simulation and match rounds cannot drift.
- **"Neutral" is `applicable: false`**, not `matched: false`: a weighted rule then
  adds the same 0 to everybody and a hard rule passes, so missing directory data
  never blocks or penalises a pair.
- `tsc --noEmit` in this container now needs >2 min — run it in the background.
