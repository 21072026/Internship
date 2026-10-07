## 2026-10-07 — application stage transitions (#1836)

- **Register a new gated model in `scripts/check-capability-writers.mjs` in the same PR that
  adds its first writer.** The guard maps `application`/`applicationEvent` → `placements`; a lib
  that writes them outside a handler needs an `EXEMPT` entry naming the gated callers, and the
  shortlist route that now writes through it had no `requireCapability()` at all — the guard cannot
  see a write behind a helper, so the gate on the caller is yours to add by hand.
- **A write-through hook must never fail the thing it hangs off.** The interview approval moves
  the application inside the same transaction, but a missing or differently-staged application
  returns `null` rather than throwing — the approval is the primary record, the application the
  secondary one.
- **Bulk = one transaction per row**, not one for the batch: a stage conflict on the fifth id must
  not roll back the four that moved, and `moved` must list only ids whose guarded write returned 1.
- **`check:openapi` reads the comment above each handler for the summary** — a new route without
  one still passes, but reads as `PATCH /api/...` in the explorer. Write the one-line comment.
