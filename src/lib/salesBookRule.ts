// Who SEES and who WORKS a record on the sales surface (`/sales/*`).
//
// The user's rule (2026-11-15, the team view; it replaces the "own book only"
// read of #3755): an organization is closed to the outside and open inside —
// every seller sees the whole team's leads and customers, because seeing each
// other's work is part of the motivation. Working a record is still the
// owner's:
//
//   READ  — `salesBookReadWhere(view)`: "mine" is `mentorId = self` (the
//           default, what #3755 shipped), "team" is every sales record of the
//           org. Never wider than the org: the caller ALWAYS ANDs its tenant
//           filter (withinTenant), and only a role with the sales surface
//           (`hasSalesSurface`) gets here at all.
//   WRITE — `salesBookWriteAllowed(facts)`: the record's owner, the org's sales
//           dispatcher (#3656, not under impersonation), or an admin holding
//           `relation.write` on it. Every write route asks this (or the same
//           facts through its own guard) on the server, independent of what a
//           read showed; a colleague's record is read-only, never writable.
//
// One module, two functions, so a page cannot show an editor that the route
// would refuse and a list cannot hold a card that would not open.
// Dependency-free so scripts/test/sales-book-rule.test.mjs loads it under plain Node.

export type SalesBookView = 'mine' | 'team';

export function isSalesBookView(value: unknown): value is SalesBookView {
  return value === 'mine' || value === 'team';
}

/** The `view` a request asked for; anything else is the default "mine". */
export function salesBookView(value: unknown): SalesBookView {
  return isSalesBookView(value) ? value : 'mine';
}

export type SalesBookWhere = { mentorId: string } | Record<string, never>;

/**
 * Which of the org's sales records a view lists and opens. "mine" is the
 * viewer's own book — the whole org's for the dispatcher, whose book it is;
 * "team" is the whole org's for everybody. The org conjunct is the caller's.
 */
export function salesBookReadWhere(viewer: { userId: string; dispatcher: boolean }, view: SalesBookView): SalesBookWhere {
  if (view === 'team' || viewer.dispatcher) return {};
  return { mentorId: viewer.userId };
}

/** #3755's name for the "mine" read — kept for its callers. */
export function salesBookWhere(viewer: { userId: string; dispatcher: boolean }): SalesBookWhere {
  return salesBookReadWhere(viewer, 'mine');
}

/**
 * May this viewer WORK (any write) this record? The facts are resolved by the
 * server: `dispatcher` is `dispatcherMay(actor, 'relation.write', orgId)` (false
 * under impersonation), `adminWrite` is the admin permission on the record.
 */
export function salesBookWriteAllowed(facts: { userId: string; ownerId: string; dispatcher: boolean; adminWrite: boolean }): boolean {
  return facts.ownerId === facts.userId || facts.dispatcher || facts.adminWrite;
}
