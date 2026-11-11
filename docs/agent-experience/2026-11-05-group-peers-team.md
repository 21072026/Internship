## 2026-11-05 — A mentee owner's circle reads group seats (#3584)

- **Re-judge in the pure rule what the query already filtered.** The loader narrows to ACTIVE
  relations, live seats and the tenant, and `seatCounts()` checks every seat again (left, ended,
  benched, inactive, other org). The query can widen later — a new `OR`, a dropped `withinTenant`
  — without anyone noticing; the unit test pins the rule. That is also how a row of bad data (a
  person of another org seated in a group) stays out: the e2e spec seeds exactly that.
- **Export names in a pure rule module collide quietly in a type-only position.** Adding
  `interface TeamSeat` next to the existing `type TeamSeat = 'OWNER' | …` gave a babel
  "already declared" error that made Playwright list **0 tests** in every file ("No tests found"),
  not an error naming the spec. When `--list` comes back empty, run `npx playwright test --list`
  unfiltered and read the first SyntaxError.
