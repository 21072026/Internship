// The estimated value of won deals, month by month (#2422, story #2393).
//
// "What did we win this month, what did we lose, and what are the accounts we
// hold worth at the month's end?" — answered from the pipeline's own audit
// trail. Pure and client-safe (no Prisma, no clock, no environment): the API
// route loads the rows, this file does the arithmetic, the screen renders it.
//
// ESTIMATED, ALWAYS. The MARKETING vertical sells usage-based pricing — a base
// fee plus transaction tiers — so an account's real monthly revenue changes
// every month and lives in the billing system. What a record carries
// (`RelationValue`) is the figure a rep typed or the import brought in, and
// every label that shows a sum of it says "estimated". Nothing here computes a
// price; it only stores and adds up estimates.
//
// THREE RULES THIS FILE IS BUILT AROUND
//
//   1. MONEY IS src/lib/roi.ts's MONEY. Integer minor units plus an ISO 4217
//      code, validated by the same `isMoney` / `normaliseCurrency` /
//      `CURRENCY_RE` the ROI model uses; nothing is ever divided, so nothing is
//      ever rounded — the sums are exact. A window that holds more than one
//      currency is REFUSED with the same typed `mixed_currency` error ROI
//      returns: converting needs a rate, a rate date and a source, and this
//      module has none of them.
//
//   2. EVERY MONTH IS REBUILT FROM StatusChange, NEVER FROM TODAY'S STAGE. A
//      month's numbers read only the moves recorded before that month ended, so
//      a deal lost today does not reach back and un-win last quarter — a
//      historical figure that changes when the board changes is not history.
//      The one thing that is NOT historised is the estimate itself: a record's
//      value is its current estimate, so re-estimating an account restates the
//      past months it was active in. That is the honest reading of an estimate
//      (the new figure is the better guess for those months too), and the
//      screen says the values are estimates.
//
//   3. WON AND LOST MEAN WHAT THE RETENTION TRIANGLE SAYS THEY MEAN. A journey
//      is won at its FIRST arrival at a won stage (or at its start, if it
//      started won), and it churns at its FIRST arrival at a loss stage after
//      that — `retentionTriangle` in src/lib/funnelKpi.ts, including its two
//      fallbacks (no won keys → the last stage of `order`; no off-path keys →
//      anything outside `order`). `winAndLoss()` below restates that rule for
//      this shape and scripts/test/deal-value.test.mjs pins the two against
//      each other, so "won in March" cannot mean one thing on the triangle and
//      another on the value card of the same screen.
//
// TRANSFER CHAINS ARE ONE JOURNEY. A mentor transfer closes the relation and
// opens a successor on the same stage, linked by `previousRelationId`. Read as
// two relations that is a second win in the transfer month and a predecessor
// that is "still active" forever; the value would be counted twice for every
// month after the handover. So the chain is folded into one journey first —
// the root's start, every link's moves — and valued by its newest link.
// (#2556 adds the shared `relationChains`/`mergeChainJourney` helpers to
// funnelKpi.ts for the funnel route; once both are on main, `foldChains` here
// should delegate to them. The semantics are the same by design.)

import { CURRENCY_RE, isMoney, normaliseCurrency } from './roi';
import { isPeriod, periodRange, type Period } from './meteringRules';
import { parseMinorUnits } from './money';
import type { Journey } from './funnelKpi';
import type { VerticalCapability } from './verticals';

// ── What a value may be ─────────────────────────────────────────────────────

/**
 * The currencies a deal value may carry. Closed on purpose, and every one has
 * two minor digits — `formatMinorAmount` (src/lib/money.ts) assumes that, and a
 * zero-decimal currency would print a hundred times too large.
 */
export const DEAL_VALUE_CURRENCIES = ['EUR', 'CHF', 'GBP', 'USD', 'TRY'] as const;
export type DealValueCurrency = (typeof DEAL_VALUE_CURRENCIES)[number];
export const DEFAULT_DEAL_VALUE_CURRENCY: DealValueCurrency = 'EUR';

/**
 * Upper bound, in minor units: 10 000 000.00 a month. The column is a MySQL
 * INT (2 147 483 647), and a monthly estimate above ten million is a typo
 * (a cent amount typed as euros) rather than an account.
 */
export const DEAL_VALUE_MAX_MINOR = 1_000_000_000;

export function isDealValueCurrency(value: unknown): value is DealValueCurrency {
  return typeof value === 'string' && (DEAL_VALUE_CURRENCIES as readonly string[]).includes(value);
}

/** Where a stored value came from — `RelationValue.source`. */
export const DEAL_VALUE_SOURCES = ['MANUAL', 'IMPORT'] as const;
export type DealValueSource = (typeof DEAL_VALUE_SOURCES)[number];

export type DealValueInputError = 'invalid_amount' | 'negative' | 'too_large' | 'invalid_currency';

/**
 * Validate a value an API caller sent: an integer in minor units (a float is
 * refused, not rounded — rounding someone's input is a guess) and one of the
 * allowed currencies.
 */
export function validateDealValue(
  valueMinor: unknown,
  currency: unknown,
): { ok: true; valueMinor: number; currency: DealValueCurrency } | { ok: false; error: DealValueInputError } {
  if (!isMoney(valueMinor)) return { ok: false, error: 'invalid_amount' };
  if (valueMinor < 0) return { ok: false, error: 'negative' };
  if (valueMinor > DEAL_VALUE_MAX_MINOR) return { ok: false, error: 'too_large' };
  const code = typeof currency === 'string' ? normaliseCurrency(currency) : DEFAULT_DEAL_VALUE_CURRENCY;
  if (!isDealValueCurrency(code)) return { ok: false, error: 'invalid_currency' };
  return { ok: true, valueMinor, currency: code };
}

/**
 * What a rep typed (`"49,90"`, `"1.234,50"`, `"990"`) → minor units, with the
 * importer's own parser, so a value never parses two ways. `null` = the field
 * is empty (clear the estimate).
 */
export function parseDealValueInput(
  raw: string,
): { ok: true; valueMinor: number | null } | { ok: false; error: DealValueInputError } {
  const parsed = parseMinorUnits(raw);
  if (parsed === null) return { ok: true, valueMinor: null };
  if (Number.isNaN(parsed)) return { ok: false, error: 'invalid_amount' };
  if (parsed < 0) return { ok: false, error: 'negative' };
  if (parsed > DEAL_VALUE_MAX_MINOR) return { ok: false, error: 'too_large' };
  return { ok: true, valueMinor: parsed };
}

/** Minor units → the text a two-decimal input shows (`4990` → `"49.90"`). */
export function dealValueInputText(valueMinor: number | null | undefined): string {
  if (valueMinor == null) return '';
  return `${Math.floor(valueMinor / 100)}.${String(valueMinor % 100).padStart(2, '0')}`;
}

/**
 * Whether a vertical works with deal values at all: the same rule as the
 * `/sales` surface (src/lib/salesSurface.ts) — the pipeline without the
 * mentorship module, i.e. MARKETING today. An INTERNSHIP tenant measures what a
 * placement was worth through the ROI model (Placement.valueMinor) instead, and
 * its screens stay exactly as they were.
 */
export function isDealValueEnabled(capabilities: readonly VerticalCapability[]): boolean {
  return capabilities.includes('pipeline') && !capabilities.includes('mentorship');
}

// ── Transfer chains ─────────────────────────────────────────────────────────

/** A relation's journey plus what this file needs to chain and value it. */
export interface ValueJourney extends Journey {
  id: string;
  previousRelationId: string | null;
  /** The record's estimate in minor units, or null for "not estimated". */
  valueMinor: number | null;
  currency: string | null;
}

/**
 * Fold every transfer chain into ONE journey: the root's start, the moves of
 * every link in time order (stable, so two moves in one millisecond keep their
 * recorded order), and the value of the NEWEST link that carries one — a
 * transfer copies the estimate, and a later edit on the successor is the
 * current one.
 *
 * The root is the link whose predecessor is absent (null, or not loaded — a
 * missing link degrades to "the chain begins here" rather than dropping a
 * journey). A cycle, which no write path produces, cannot loop: each link is
 * visited once. Input order is otherwise preserved (root order).
 */
export function foldChains(journeys: ValueJourney[]): ValueJourney[] {
  const byId = new Map(journeys.map((j) => [j.id, j]));
  const children = new Map<string, ValueJourney[]>();
  for (const j of journeys) {
    if (j.previousRelationId && byId.has(j.previousRelationId) && j.previousRelationId !== j.id) {
      const list = children.get(j.previousRelationId) ?? [];
      list.push(j);
      children.set(j.previousRelationId, list);
    }
  }
  const visited = new Set<string>();
  const walk = (root: ValueJourney): ValueJourney[] => {
    const chain: ValueJourney[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const link = queue.shift()!;
      if (visited.has(link.id)) continue;
      visited.add(link.id);
      chain.push(link);
      queue.push(...(children.get(link.id) ?? []));
    }
    return chain;
  };
  const merge = (chain: ValueJourney[]): ValueJourney => {
    if (chain.length === 1) return chain[0];
    const [root] = chain;
    const valued = [...chain].reverse().find((l) => l.valueMinor != null);
    return {
      ...root,
      changes: chain.flatMap((l) => l.changes).sort((a, b) => a.at - b.at),
      valueMinor: valued?.valueMinor ?? null,
      currency: valued ? valued.currency : root.currency,
    };
  };

  const out: ValueJourney[] = [];
  for (const j of journeys) {
    const isRoot = !j.previousRelationId || !byId.has(j.previousRelationId) || j.previousRelationId === j.id;
    if (isRoot && !visited.has(j.id)) out.push(merge(walk(j)));
  }
  for (const j of journeys) if (!visited.has(j.id)) out.push(merge(walk(j)));
  return out;
}

// ── Won / lost, the retention triangle's definition ─────────────────────────

export interface WinLossOptions {
  /** Stage keys that mean "won" — `outcomeStageKeysFrom().finished`. */
  wonKeys?: string[];
  /** Stage keys that mean "lost" — `outcomeStageKeysFrom().offPath`. */
  offPath?: string[] | null;
}

/**
 * When a journey was won and when it was lost after that (ms), each null when
 * it did not happen. Exactly `retentionTriangle`'s reading, fallbacks included
 * (see the header, rule 3).
 */
export function winAndLoss(
  order: string[],
  journey: Journey,
  options: WinLossOptions = {},
): { wonAt: number | null; lostAt: number | null } {
  const onPath = new Set(order);
  const wonKeys = new Set(options.wonKeys && options.wonKeys.length > 0 ? options.wonKeys : order.slice(-1));
  const lossKeys = options.offPath && options.offPath.length > 0 ? new Set(options.offPath) : null;
  const isLoss = (key: string) => (lossKeys ? lossKeys.has(key) : !onPath.has(key));

  let wonAt: number | null = null;
  let from = 0;
  if (wonKeys.has(journey.startStatus)) {
    wonAt = journey.startedAt;
  } else {
    const i = journey.changes.findIndex((c) => wonKeys.has(c.toStatus));
    if (i >= 0) {
      wonAt = journey.changes[i].at;
      from = i + 1;
    }
  }
  if (wonAt === null) return { wonAt: null, lostAt: null };
  const lost = journey.changes.slice(from).find((c) => isLoss(c.toStatus));
  return { wonAt, lostAt: lost ? lost.at : null };
}

// ── The monthly series ──────────────────────────────────────────────────────

/** A count of journeys and the sum of the estimates of those that have one. */
export interface ValueTally {
  count: number;
  /** Sum of the estimates, minor units. Journeys with no estimate add 0 … */
  valueMinor: number;
  /** … and are counted here, so a sum that covers half the deals says so. */
  unvalued: number;
}

export interface DealValueMonth {
  month: Period;
  /** Journeys first won in this month. */
  won: ValueTally;
  /** Journeys that churned in this month (first loss after the win). */
  lost: ValueTally;
  /** Journeys won by the month's end and not churned by it — the book of accounts. */
  activeAtEnd: ValueTally;
}

export interface DealValueSeries {
  ok: true;
  /** The one currency every counted estimate is in (the default when none has one). */
  currency: string;
  months: DealValueMonth[];
}

/** The same error shape src/lib/roi.ts returns — the screen already speaks it. */
export type DealValueError =
  | { ok: false; error: 'mixed_currency'; currencies: string[] }
  | { ok: false; error: 'invalid_currency'; currencies: string[] }
  | { ok: false; error: 'invalid_amount'; field: string };

export type DealValueResult = DealValueSeries | DealValueError;

export interface ValueByMonthOptions extends WinLossOptions {
  /** Journeys are transfer-chain links; fold them first (the default). */
  foldTransferChains?: boolean;
}

const emptyTally = (): ValueTally => ({ count: 0, valueMinor: 0, unvalued: 0 });

/**
 * Won / lost / active-at-month-end, with the estimated value of each, for
 * every month in `months` (oldest first, `cohortMonths()`'s shape).
 *
 * A journey is ACTIVE AT THE END of month M when it was won before M closed
 * and had not churned before M closed; it is WON IN M / LOST IN M when that
 * arrival falls inside M. Month boundaries are `periodRange()` — UTC,
 * half-open — and nowhere else (src/lib/meteringRules.ts).
 *
 * Returns the typed error instead of a series when the journeys that actually
 * reach one of the months carry more than one currency; a valued journey that
 * touches none of them does not count against the window.
 */
export function valueByMonth(
  order: string[],
  journeys: ValueJourney[],
  months: Period[],
  options: ValueByMonthOptions = {},
): DealValueResult {
  const windows = months
    .filter((m) => isPeriod(m))
    .map((month) => {
      const r = periodRange(month);
      return { month, start: r.gte.getTime(), end: r.lt.getTime() };
    });
  const folded = options.foldTransferChains === false ? journeys : foldChains(journeys);

  const result: DealValueMonth[] = windows.map((w) => ({
    month: w.month,
    won: emptyTally(),
    lost: emptyTally(),
    activeAtEnd: emptyTally(),
  }));
  const currencies = new Set<string>();
  const malformed = new Set<string>();

  for (let i = 0; i < folded.length; i++) {
    const j = folded[i];
    const { wonAt, lostAt } = winAndLoss(order, j, options);
    if (wonAt === null) continue;

    let touched = false;
    const add = (tally: ValueTally) => {
      touched = true;
      tally.count++;
      if (j.valueMinor == null) tally.unvalued++;
      else tally.valueMinor += j.valueMinor;
    };
    windows.forEach((w, k) => {
      const row = result[k];
      if (wonAt >= w.start && wonAt < w.end) add(row.won);
      if (lostAt !== null && lostAt >= w.start && lostAt < w.end) add(row.lost);
      if (wonAt < w.end && (lostAt === null || lostAt >= w.end)) add(row.activeAtEnd);
    });

    if (touched && j.valueMinor != null) {
      if (!isMoney(j.valueMinor)) return { ok: false, error: 'invalid_amount', field: `journeys[${i}].valueMinor` };
      const raw = j.currency ?? DEFAULT_DEAL_VALUE_CURRENCY;
      const code = normaliseCurrency(raw);
      if (CURRENCY_RE.test(code)) currencies.add(code);
      else malformed.add(raw);
    }
  }

  if (malformed.size > 0) return { ok: false, error: 'invalid_currency', currencies: [...malformed].sort() };
  if (currencies.size > 1) return { ok: false, error: 'mixed_currency', currencies: [...currencies].sort() };
  return {
    ok: true,
    currency: currencies.values().next().value ?? DEFAULT_DEAL_VALUE_CURRENCY,
    months: result,
  };
}
