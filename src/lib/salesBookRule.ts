// The sales surface is the person's OWN book (the user's rule, 2026-11-15; #3755).
//
// `/sales/*` — the board, the lead page, the lists — shows `mentorId = self`
// records for everybody, an ADMIN of any tier included. The ONE exception is
// the org's sales dispatcher (#3656, src/lib/salesDispatcher.ts), who works the
// whole tenant's book and whose lead page already opens any record of it. An
// admin reads the whole book on /admin/board and /admin/candidates, whose cards
// open the admin detail — never /sales/leads/<id>.
//
// Why one rule: the board used to list what GET /api/mentorship lets the role
// read (the whole tenant for an ORG_ADMIN / OBSERVER, the grants of a
// PROGRAM_ADMIN, both sides of a relation for a MENTOR) while the lead page
// opened only `mentorId = self` — so a card of somebody else's lead was on the
// board and its click was a 404. Every card a viewer sees must open for that
// viewer: the list and the page read this one answer.
//
// Dependency-free so scripts/test/sales-book-rule.test.mjs loads it under plain
// Node. The org conjunct is NOT here: every caller already ANDs its tenant
// filter, and this only ever narrows.

export type SalesBookWhere = { mentorId: string } | Record<string, never>;

/** Which of the tenant's relations belong to this person's sales book. */
export function salesBookWhere(viewer: { userId: string; dispatcher: boolean }): SalesBookWhere {
  return viewer.dispatcher ? {} : { mentorId: viewer.userId };
}
