// The sales team page's counts (#3779) — the rule, pure and dependency-free so
// scripts/test/sales-team-rule.test.mjs loads it under plain Node. The rows and
// counts come from the team book loader (src/lib/salesTeamBook.ts, WP2a); this
// only shapes them for the page.

/**
 * The team's open book in counts: active records per stage, and per seller
 * their records per stage and how many of their follow-ups are overdue.
 * Names and counts only.
 */
export interface TeamBookCounts {
  byStage: Map<string, number>;
  people: Array<{ id: string; fullName: string; byStage: Map<string, number>; overdue: number }>;
  /** The per-seller stage split is only known when the book was not truncated. */
  splitKnown: boolean;
  /** Overdue follow-ups of every owner, listed seller or not (a deactivated one too). */
  overdueTotal: number;
}

/** The shape of the team book loader's answer that this page reads (src/lib/salesTeamBook.ts, WP2a). */
export interface TeamBookSlice {
  rows: ReadonlyArray<{ ownerId: string; pipelineStatus: string }>;
  byStage: ReadonlyArray<{ stage: string; count: number }>;
  byOwner: ReadonlyArray<{ ownerId: string; ownerName: string; count: number }>;
  truncated: boolean;
}

/**
 * Counts from the team book (pure, unit-tested): the stage strip is its
 * `byStage`, each seller's total its `byOwner`, and each seller's stage split
 * is read from its rows — only when the book is complete (`truncated` false),
 * so a split is never guessed from a partial list. `people` adds the sellers
 * with no open record (at 0) so nobody drops off the table; `overdue` is the
 * per-owner count of overdue follow-ups.
 */
export function teamBookCounts(
  book: TeamBookSlice,
  people: ReadonlyArray<{ id: string; fullName: string }>,
  overdue: ReadonlyMap<string, number>,
): TeamBookCounts {
  const split = new Map<string, Map<string, number>>();
  if (!book.truncated) {
    for (const r of book.rows) {
      const m = split.get(r.ownerId) ?? new Map<string, number>();
      m.set(r.pipelineStatus, (m.get(r.pipelineStatus) ?? 0) + 1);
      split.set(r.ownerId, m);
    }
  }
  const names = new Map<string, string>();
  for (const p of people) names.set(p.id, p.fullName);
  for (const o of book.byOwner) if (!names.has(o.ownerId)) names.set(o.ownerId, o.ownerName);
  const totals = new Map(book.byOwner.map((o) => [o.ownerId, o.count]));
  return {
    byStage: new Map(book.byStage.map((g) => [g.stage, g.count])),
    splitKnown: !book.truncated,
    overdueTotal: [...overdue.values()].reduce((n, v) => n + v, 0),
    people: [...names.entries()]
      .map(([id, fullName]) => ({
        id,
        fullName,
        // Without a split, one entry under '' carries the owner's total.
        byStage: book.truncated ? new Map([['', totals.get(id) ?? 0]]) : (split.get(id) ?? new Map()),
        overdue: overdue.get(id) ?? 0,
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
  };
}


/**
 * Who sees each seller's OVERDUE follow-up count on the team page: the org's
 * admins and the sales dispatcher — the people who act on it. A rep sees only
 * the team total (orchestrator decision 2026-11-15): the page is there for
 * motivation, and a per-person overdue column in front of the whole team
 * would read as a list of who is behind. Wins and open records stay visible
 * to everyone.
 */
export function canSeeRepOverdue(viewer: { role: string | null | undefined; dispatcher: boolean }): boolean {
  return viewer.role === 'ADMIN' || viewer.dispatcher;
}
