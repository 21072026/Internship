# 2026-10-30 — Cohort matching pass (#1794)

- **A cohort has no membership before a relation exists.** `Cohort` is reached only through
  `MentorshipRelation.cohortId` (and grants/costs), so "the cohort's mentees" of an intake that
  has no mentor yet is not a query. The pass scopes on *waiting* mentees (active MENTEE, no ACTIVE
  relation, optional `menteeIds`); the round's cohort is where #1796 puts the published pairs.
- **ADMINs are in the mentor pool with `mentorCapacity: null` = unlimited headroom.** A greedy
  pass with minimum 0 lets a skill-less admin absorb every mentee nobody else fits at score 0 —
  hence `DEFAULT_MIN_SCORE = 1`. Watch for this in any bulk use of `loadMentorPool()`.
- **"No N+1, assert a query count" without a query counter in the server process:** make the pass
  a plain function over injected loaders and count loader calls in a pure unit spec. It also makes
  the later move onto the job queue a change of caller.
- **Determinism needs more than a tie-break:** `skillOverlap()` picks equal-weight neighbours by
  edge order, and `findMany` without `orderBy` has none — `skillGraphsFor()` sorts the edges. And
  `ctx.now` is the round's `createdAt`, not the wall clock (the timezone rule reads it).
- 500 × 1000 full `MatchScore`s are too many objects for a request: keep `{mentor, score, blockedBy}`
  per pair and re-score only the chosen pair and the alternatives — `scoreMatch()` is pure, so the
  second scoring is identical.
