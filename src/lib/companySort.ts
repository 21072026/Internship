// How the company/account list is ordered (#2436).
//
// Five orders (`followup` joined in #2563), and one rule they share wherever it can apply: an account that
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
export const COMPANY_SORT_KEYS = ['name', 'created', 'movement', 'waiting', 'followup'] as const;

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
 * `_count`. So those two are ranked here, on the server — but only over the
 * accounts that HAVE a key (#2528): the rest are last by definition, in name
 * order, which the database can page by itself (`derivedPageWindow` below).
 * Still server-side ordering — the client never re-sorts.
 */
export function isDerivedSort(sort: CompanySort): boolean {
  return sort === 'movement' || sort === 'waiting' || sort === 'followup';
}

/**
 * `followup` (#2563) is keyed on the owners' next-action dates rather than on
 * stage movement, so the route reads a different set of records for it (the
 * ACTIVE ones that HAVE a date) — this says which.
 */
export function isFollowUpSort(sort: CompanySort): boolean {
  return sort === 'followup';
}

/** A funnel record as far as the ordering is concerned. */
export interface CompanySortRelation extends StageClockSource {
  companyId: string | null;
  /** The owner's follow-up date (#2563); read only by the `followup` order. */
  nextActionAt?: Date | string | null;
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
    if (sort === 'followup') {
      // Soonest follow-up first — an overdue one is sooner than any upcoming
      // one, so the accounts somebody is late on lead the list. Negated so it
      // fits the "bigger means earlier" convention; an account whose records
      // carry no date has no key and sorts last, like a never-moved account.
      if (!relation.nextActionAt) continue;
      const value = -new Date(relation.nextActionAt).getTime();
      const current = keys.get(relation.companyId);
      if (current === undefined || value > current) keys.set(relation.companyId, value);
      continue;
    }
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

/**
 * Put companies in a derived order: by key (`compareSortKeys`), then by name,
 * then by id.
 *
 * Name is the tie-breaker, including between the accounts that have no key at
 * all: those all land at the end, and they stay alphabetical there instead of
 * in whatever order the database returned. `Company.name` is not unique, and
 * `waiting` keys on whole days, so two accounts can tie on both — the id makes
 * the order total, or they would come back in the database's return order,
 * which is free to differ between two requests for neighbouring pages. A copy
 * is sorted; the input is left as it was.
 */
export function rankByDerivedKey<T extends { id: string; name: string }>(
  companies: readonly T[],
  keys: ReadonlyMap<string, number>
): T[] {
  return companies
    .slice()
    .sort(
      (a, b) =>
        compareSortKeys(keys.get(a.id), keys.get(b.id)) ||
        a.name.localeCompare(b.name) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
}

/** Which part of a derived-order page comes from where (see below). */
export interface DerivedPageWindow {
  /** `ranked.slice(headStart, headEnd)` — the keyed accounts on this page. */
  headStart: number;
  headEnd: number;
  /** The window of the keyless tail, in name order, that fills the rest. */
  tailSkip: number;
  tailTake: number;
}

/**
 * Where one page of a derived order starts and ends (#2528).
 *
 * A derived order is two runs back to back: every account that HAS a key,
 * ranked in memory, and then every account that has none. The second run is
 * last by the rule this module exists for, and ordered by name alone (id
 * breaking ties), so it is the same query as the plain `name` order and the
 * database pages it by itself — the route never
 * loads those rows just to throw them away. A page is therefore a slice of the
 * ranked head followed, once the head runs out, by a window of that tail; this
 * function does the arithmetic so the route does not.
 *
 * `keyedCount` is the length of the ranked head; `skip`/`take` are the page the
 * caller asked for.
 */
export function derivedPageWindow(
  keyedCount: number,
  skip: number,
  take: number
): DerivedPageWindow {
  const headStart = Math.min(skip, keyedCount);
  const headEnd = Math.min(skip + take, keyedCount);
  return {
    headStart,
    headEnd,
    tailSkip: Math.max(0, skip - keyedCount),
    tailTake: take - (headEnd - headStart),
  };
}
