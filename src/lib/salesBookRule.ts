// The sales surface: WRITING is the person's OWN book (#3755); READING is the
// team's (the user's decision, 2026-11-15 — the org is closed in on itself,
// everybody sees everybody's work).
//
// `salesBookWhere` below is the ownership and write scope and stays exactly as
// #3755 set it: the board's "Mine", the queue, what a rep may change. The team
// read is a separate, read-only path: `canReadSalesTeamBook` decides whether a
// viewer may read the org's whole book (the org setting `salesTeamBookForReps`,
// default on, for a rep; always for an admin or the dispatcher), and
// `salesTeamReadWhere` is the narrowing it implies. Its consumers are
// src/lib/salesTeamBook.ts (GET /api/sales/team-book, /sales/team, the board's
// "Team") and the read-only lead page. Writing never follows it.
//
// What follows is the #3755 rule for the OWN book:
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

/** Whether this viewer may READ the org's whole sales book (never a write). */
export function canReadSalesTeamBook(viewer: { teamSetting: boolean; role: string; dispatcher: boolean }): boolean {
  return viewer.role === 'ADMIN' || viewer.dispatcher || (viewer.role === 'MENTOR' && viewer.teamSetting);
}

/**
 * The narrowing a team read implies, inside the caller's tenant filter: `{}` —
 * the whole tenant — when allowed, `null` (read nothing) when not. Never a
 * widening past the tenant: the caller ANDs its own org conjunct, as above.
 */
export function salesTeamReadWhere(allowed: boolean): Record<string, never> | null {
  return allowed ? {} : null;
}

/** The org setting as stored: anything but an explicit 'false' is the default, on. */
export function parseSalesTeamBookSetting(raw: string | null | undefined): boolean {
  return raw !== 'false';
}
