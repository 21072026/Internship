## 2026-10-31 — time to hire from funnel entry (#1505)

- **Moving a journey's start moves its window filter too.** The funnel route keeps a window's
  journeys by `startedAt >= from`, but loads them with an SQL `OR` over `startDate`, stage moves and
  trial starts. Once `startedAt` became `funnelEnteredAt ?? startDate`, a pair that entered the
  funnel inside the window through a kind change (which writes no StatusChange) was never loaded.
  When you change what a derived timestamp means, grep the SQL superset that feeds it.
- **One helper, every builder.** The issue named the funnel and mentor routes; the forecast and
  deal-value routes build the same `Journey` by hand. `funnelStartedAt()` sits in
  `src/lib/placement.ts` next to the other placement rules, and `Journey.startedAt`'s comment
  points at it, so the next builder does not copy `startDate`.
- **An e2e can read the tenant's own completion stage first.** Calling the funnel on the empty
  org returns `timeToHire.completionKey`, so the spec does not hard-code the last on-path key.
