# 2026-10-29 — Chat delivery ledger + retry (#1960)

- "Retry through the router" needs the original card, and a ledger that deliberately stores no
  body cannot rebuild it. The router writes the in-app `Notification` (type + params + link) in
  the same pass, so the retry reads that row (a time window around the failed attempt) and
  answers `source_gone` when it is pruned — never a guessed card.
- An idempotent retry button: key the retry's own router ledger row on the FAILED attempt's id
  (`retry:<id>` into the dedupe hash), so a double click is one send and the second answers 409.
- Specs that drive a cold `next dev` page sometimes need 20s on the first assertion; a spec that
  passed 3/3 can still fail once on a cold server — rerun before chasing a phantom bug.
