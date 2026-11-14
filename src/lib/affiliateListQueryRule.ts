// Filters and sort of the admin's affiliate lists — commissions, customer
// payments, partner payouts and partners (docs/affiliate-module.md § Admin
// screens, #3539). The same allowlist pattern as the funnel board
// (src/lib/affiliateFunnelBoardRule.ts): a request names a sort KEY, and this
// file maps it to an order. No request string ever reaches a query as a field
// name, and every order ends with the row id so equal rows keep a stable order
// across pages.
//
// PURE and dependency-free (one sibling for the calendar day). The URL is the
// state: the screens read their query with the same parser the routes use, and
// write it back with `listQueryParams()`, so a link opens the same view.
// Unit-tested in scripts/test/affiliate-list-query-rule.test.mjs.

import { parseCalendarDay } from './calendarDay';

export type SortDir = 'asc' | 'desc';

export interface ListSpec {
  sorts: readonly string[];
  defaultSort: string;
  defaultDir: SortDir;
  /** Allowed `status` values; absent = the list has no status filter. */
  statuses?: readonly string[];
  /** Allowed `kind` values; absent = the list has no kind filter. */
  kinds?: readonly string[];
  /** `from` / `to` calendar days. */
  dateRange?: boolean;
  /** `q` free-text search. */
  search?: boolean;
  /** `partnerId`. */
  partner?: boolean;
}

export const COMMISSION_LIST = {
  sorts: ['due', 'amount', 'partner'],
  defaultSort: 'due',
  defaultDir: 'asc',
  statuses: ['PENDING', 'APPROVED', 'PAID', 'REJECTED'],
  kinds: ['TIER', 'PERCENT', 'IMPORTED'],
  dateRange: true,
  partner: true,
} as const satisfies ListSpec;

export const PAYMENT_LIST = {
  sorts: ['date', 'amount'],
  defaultSort: 'date',
  defaultDir: 'desc',
  dateRange: true,
  search: true,
  partner: true,
} as const satisfies ListSpec;

export const PAYOUT_LIST = {
  sorts: ['date', 'amount'],
  defaultSort: 'date',
  defaultDir: 'desc',
  dateRange: true,
  search: true,
  partner: true,
} as const satisfies ListSpec;

export const PARTNER_LIST = {
  sorts: ['created', 'name', 'customers', 'open'],
  defaultSort: 'created',
  defaultDir: 'desc',
  statuses: ['ACTIVE', 'SUSPENDED', 'TERMINATED'],
  search: true,
} as const satisfies ListSpec;

/** Longest search term kept; a longer one is refused, never cut silently. */
export const LIST_SEARCH_MAX = 100;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ListQuery {
  partnerId: string | null;
  q: string | null;
  /** Calendar days, `YYYY-MM-DD`, both inclusive. */
  from: string | null;
  to: string | null;
  status: string | null;
  kind: string | null;
  sort: string;
  dir: SortDir;
  page: number;
}

export type ListQueryField = 'partnerId' | 'q' | 'from' | 'to' | 'range' | 'status' | 'kind' | 'sort' | 'dir';

/** The query when the URL says nothing. */
export function defaultListQuery(spec: ListSpec): ListQuery {
  return { partnerId: null, q: null, from: null, to: null, status: null, kind: null, sort: spec.defaultSort, dir: spec.defaultDir, page: 1 };
}

/**
 * Reads one list's query. Absent or empty values take their default; a present
 * value outside the list's allowlist is refused (the route answers 400), never
 * passed on. A parameter the list does not offer is ignored. `page` is clamped
 * the way the lists always clamped it (1 … 10 000; anything else is page 1).
 */
export function parseListQuery(spec: ListSpec, params: URLSearchParams): { ok: true; query: ListQuery } | { ok: false; field: ListQueryField } {
  const get = (k: string) => {
    const v = params.get(k);
    return v === null || v.trim() === '' ? null : v.trim();
  };
  const query = defaultListQuery(spec);

  if (spec.partner) {
    const partnerId = get('partnerId');
    if (partnerId !== null && !ID_RE.test(partnerId)) return { ok: false, field: 'partnerId' };
    query.partnerId = partnerId;
  }
  if (spec.search) {
    const q = get('q');
    if (q !== null && q.length > LIST_SEARCH_MAX) return { ok: false, field: 'q' };
    query.q = q;
  }
  if (spec.dateRange) {
    for (const k of ['from', 'to'] as const) {
      const v = get(k);
      if (v !== null && !parseCalendarDay(v)) return { ok: false, field: k };
      query[k] = v;
    }
    if (query.from && query.to && query.from > query.to) return { ok: false, field: 'range' };
  }
  for (const [k, allowed] of [['status', spec.statuses], ['kind', spec.kinds]] as const) {
    if (!allowed) continue;
    const v = get(k);
    if (v !== null && !allowed.includes(v)) return { ok: false, field: k };
    query[k] = v;
  }
  const sort = get('sort') ?? spec.defaultSort;
  if (!spec.sorts.includes(sort)) return { ok: false, field: 'sort' };
  query.sort = sort;
  const dir = get('dir') ?? spec.defaultDir;
  if (dir !== 'asc' && dir !== 'desc') return { ok: false, field: 'dir' };
  query.dir = dir;
  const raw = Math.floor(Number(get('page') ?? 1));
  query.page = Number.isFinite(raw) ? Math.min(10_000, Math.max(1, raw)) : 1;
  return { ok: true, query };
}

/** The query back as URL parameters — defaults left out, so a plain link stays plain. */
export function listQueryParams(spec: ListSpec, query: ListQuery): URLSearchParams {
  const out = new URLSearchParams();
  if (query.partnerId) out.set('partnerId', query.partnerId);
  if (query.q) out.set('q', query.q);
  if (query.from) out.set('from', query.from);
  if (query.to) out.set('to', query.to);
  if (query.status) out.set('status', query.status);
  if (query.kind) out.set('kind', query.kind);
  if (query.sort !== spec.defaultSort) out.set('sort', query.sort);
  if (query.dir !== spec.defaultDir) out.set('dir', query.dir);
  if (query.page > 1) out.set('page', String(query.page));
  return out;
}

/** Whether anything but the sort and the page narrows the list (for the "clear filters" control). */
export function hasListFilter(query: ListQuery): boolean {
  return Boolean(query.partnerId || query.q || query.from || query.to || query.status || query.kind);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The date range as a half-open UTC interval: `from` at midnight, `to` INCLUSIVE
 * (its next midnight excluded). The stored dates are calendar days at UTC
 * midnight (payments, payouts) or instants (a commission's due date), and both
 * fall inside the day they are shown on.
 */
export function listDateRange(query: Pick<ListQuery, 'from' | 'to'>): { gte?: Date; lt?: Date } | null {
  const from = query.from ? parseCalendarDay(query.from) : null;
  const to = query.to ? parseCalendarDay(query.to) : null;
  if (!from && !to) return null;
  return { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + DAY_MS) } : {}) };
}

// ── Orders ──────────────────────────────────────────────────────────────────
// One table per list. The value is a Prisma orderBy built from constants; the
// direction is the parsed 'asc' | 'desc'. The id tiebreak follows the direction.

type Order = Record<string, unknown>[];

const COMMISSION_ORDER: Record<(typeof COMMISSION_LIST.sorts)[number], (dir: SortDir) => Order> = {
  due: (dir) => [{ dueAt: dir }],
  amount: (dir) => [{ amountMinor: dir }],
  partner: (dir) => [{ partner: { displayName: dir } }, { dueAt: 'asc' }],
};
const PAYMENT_ORDER: Record<(typeof PAYMENT_LIST.sorts)[number], (dir: SortDir) => Order> = {
  date: (dir) => [{ receivedAt: dir }],
  amount: (dir) => [{ amountMinor: dir }],
};
const PAYOUT_ORDER: Record<(typeof PAYOUT_LIST.sorts)[number], (dir: SortDir) => Order> = {
  date: (dir) => [{ paidAt: dir }],
  amount: (dir) => [{ amountMinor: dir }],
};

function orderFrom(table: Record<string, (dir: SortDir) => Order>, fallback: string, query: Pick<ListQuery, 'sort' | 'dir'>): Order {
  const build = Object.hasOwn(table, query.sort) ? table[query.sort] : table[fallback];
  return [...build(query.dir), { id: query.dir }];
}

export const commissionOrderBy = (query: Pick<ListQuery, 'sort' | 'dir'>) => orderFrom(COMMISSION_ORDER, COMMISSION_LIST.defaultSort, query);
export const paymentOrderBy = (query: Pick<ListQuery, 'sort' | 'dir'>) => orderFrom(PAYMENT_ORDER, PAYMENT_LIST.defaultSort, query);
export const payoutOrderBy = (query: Pick<ListQuery, 'sort' | 'dir'>) => orderFrom(PAYOUT_ORDER, PAYOUT_LIST.defaultSort, query);

/** What the partner list sorts on. `open` is the commission not yet paid: pending + approved. */
export interface PartnerSortable {
  id: string;
  displayName: string;
  createdAt: string;
  customers: number;
  totals: { PENDING: number; APPROVED: number };
}

const PARTNER_VALUE: Record<(typeof PARTNER_LIST.sorts)[number], (r: PartnerSortable) => string | number> = {
  created: (r) => r.createdAt,
  name: (r) => r.displayName.toLocaleLowerCase('en'),
  customers: (r) => r.customers,
  open: (r) => r.totals.PENDING + r.totals.APPROVED,
};

/**
 * The partner list is not paged (every partner, with totals summed in SQL), so
 * it is sorted here, on the server, after the sums. Sorted copy; ties by id.
 */
export function sortPartnerRows<T extends PartnerSortable>(rows: T[], query: Pick<ListQuery, 'sort' | 'dir'>): T[] {
  const value = Object.hasOwn(PARTNER_VALUE, query.sort) ? PARTNER_VALUE[query.sort as keyof typeof PARTNER_VALUE] : PARTNER_VALUE.created;
  const sign = query.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va !== vb) return (va < vb ? -1 : 1) * sign;
    return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * sign;
  });
}
