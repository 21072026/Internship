// How the company/account list is ordered (#2436).
//
// Four orders, and one rule they share wherever it can apply: an account that
// has never moved through the pipeline sorts LAST. That is the whole lesson of
// the inherited task — MySQL puts NULLs FIRST on an ascending sort and LAST on
// a descending one, so "no data" silently becomes "the most interesting row" in
// half of the orders unless somebody says otherwise. Here nobody has to
// remember: `compareSortKeys` is the only comparator, and it is explicit.
//
// "WHEREVER IT CAN APPLY" is the honest reading of #2436's "rows with no stage
// movement come last in every sort", and worth stating rather than leaving to
// be re-derived. The rule is about a MISSING key, which is why the issue
// phrases the mechanism as `orderBy: { sort: 'asc', nulls: 'last' }` — a
// nulls-last instruction is meaningless without nulls. `movement` and `waiting`
// are keyed on stage movement and an account can lack one, so those two carry
// it. `name` and `created` are total orders over columns every row has: a
// never-moved account sorts alphabetically, or by when it was added, among the
// rest, because that is what those two orders were asked for.
//
// Dependency-free on purpose (only `stageClock`, which is itself client-safe):
// the route decides WHICH rows it may read, this module decides only what order
// they come back in, and `scripts/test/company-sort.test.mjs` can exercise the
// rules without a database.

import { daysInStage, lastStageMoveAt, type StageClockSource } from './stageClock';

/**
 * The orders the list offers, in the order the picker shows them.
 *
 * Bare keys rather than a `Record<…, string>` of labels: the labels are
 * dictionary entries (`companiesPage.sortOptions`, en/tr/de), and a map from key
 * to English here would be a second place where a user-visible string lives.
 */
export const COMPANY_SORT_KEYS = ['name', 'created', 'movement', 'waiting'] as const;

export type CompanySort = (typeof COMPANY_SORT_KEYS)[number];

export const DEFAULT_COMPANY_SORT: CompanySort = 'name';

export function isCompanySort(value: unknown): value is CompanySort {
  return typeof value === 'string' && (COMPANY_SORT_KEYS as readonly string[]).includes(value);
}

/**
 * Read the `sort` query parameter.
 *
 * An unknown value falls back to the default rather than failing: a stale
 * bookmark, a hand-typed URL or a client that ships a new option before the
 * server does must produce a list, never a 500 (acceptance criterion of #2436).
 */
export function parseCompanySort(value: string | null | undefined): CompanySort {
  return isCompanySort(value) ? value : DEFAULT_COMPANY_SORT;
}

/**
 * Orders whose key is NOT a column on `Company`.
 *
 * `name` and `created` are plain scalars and are handed to Prisma's `orderBy`,
 * which pages them in the database. The other two are derived from the
 * account's funnel records — the newest real `StatusChange`, and the stage
 * clock — and Prisma cannot express "order Company by max(StatusChange.createdAt)
 * across a to-many relation": `orderBy` reaches related rows only through
 * `_count`. So those two are ranked here, on the server, over the whole scoped
 * result set before the page is sliced out of it (the same shape as the
 * in-memory skill filter in `/api/candidates`). Still server-side ordering —
 * the client never re-sorts.
 */
export function isDerivedSort(sort: CompanySort): boolean {
  return sort === 'movement' || sort === 'waiting';
}

/** A funnel record as far as the ordering is concerned. */
export interface CompanySortRelation extends StageClockSource {
  companyId: string | null;
}

/**
 * The sort key of every company that HAS one, keyed by company id.
 *
 * Both derived orders rank highest-first (most recent movement / longest wait),
 * so both keys are "bigger means earlier in the list". A company is absent from
 * the map when none of its funnel records has ever really moved stage — which
 * includes an account with no funnel records at all — and an absent key is what
 * `compareSortKeys` puts last.
 *
 * An account can carry several records; the account's key is the strongest of
 * them, because the list answers a question about the ACCOUNT ("when did
 * anything last happen here", "how long has this been sitting"), and the
 * quietest of five deals must not drag a busy account to the bottom.
 */
export function companySortKeys(
  relations: readonly CompanySortRelation[],
  sort: CompanySort,
  now: number = Date.now()
): Map<string, number> {
  const keys = new Map<string, number>();
  if (!isDerivedSort(sort)) return keys;

  for (const relation of relations) {
    if (!relation.companyId) continue;
    // The nullable "did it ever move" answer, not `stageEnteredAt`: a record
    // that never moved has been in its first stage since it was created, and
    // #2436 wants those grouped at the end instead of competing for the top of
    // "longest waiting" on the strength of an old start date alone.
    if (lastStageMoveAt(relation) === null) continue;
    const value = sort === 'movement' ? lastStageMoveAt(relation)! : daysInStage(relation, now);
    const current = keys.get(relation.companyId);
    if (current === undefined || value > current) keys.set(relation.companyId, value);
  }
  return keys;
}

/**
 * Rank two derived keys: bigger first, and a missing key ALWAYS last — also
 * when both are missing, where the tie is broken by the caller's fallback so
 * the order stays stable rather than depending on the fetch order.
 */
export function compareSortKeys(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return b - a;
}
