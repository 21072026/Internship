// Structured compensation on an offer (#1851) — the pure half.
//
// NO PRISMA IMPORT, and no Intl: this is read by the offer wizard (a client
// component) and by the benchmark route alike, and every amount is an INTEGER
// IN MINOR UNITS plus an ISO 4217 code — the money rule the schema states at
// ProgramCost/Placement. Nothing here adds two floats, and nothing here is
// stored: `normalizeToMonthlyMinor` exists so two offers can be COMPARED, and
// the benchmark derives it per request rather than keeping a column that
// drifts the moment `hoursPerWeek` is edited.
//
// Run the tests: node --test --experimental-strip-types scripts/test/compensation.test.mjs

/** The currencies an offer may be denominated in. The product targets DE/AT/CH
 * and TR, so EUR and TRY both occur; the list is CLOSED rather than "any ISO
 * code" because `formatMinorAmount` (src/lib/money.ts) assumes two decimals. */
export const OFFER_CURRENCIES = ['EUR', 'TRY', 'USD', 'CHF', 'GBP'] as const;
export type OfferCurrency = (typeof OFFER_CURRENCIES)[number];
export function isOfferCurrency(value: unknown): value is OfferCurrency {
  return typeof value === 'string' && (OFFER_CURRENCIES as readonly string[]).includes(value);
}

export const BASE_PERIODS = ['HOURLY', 'MONTHLY', 'YEARLY'] as const;
export type BasePeriod = (typeof BASE_PERIODS)[number];
export function isBasePeriod(value: unknown): value is BasePeriod {
  return typeof value === 'string' && (BASE_PERIODS as readonly string[]).includes(value);
}

export const CONTRACT_TYPES = ['INTERNSHIP', 'WORKING_STUDENT', 'FIXED_TERM', 'PERMANENT'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export function isContractType(value: unknown): value is ContractType {
  return typeof value === 'string' && (CONTRACT_TYPES as readonly string[]).includes(value);
}

/** The widest an amount may be: 10^12 minor units (ten billion in major
 * units) — far above any salary, and inside a signed 32-bit column would not
 * be, so the column is checked at write time rather than by Prisma's P2000. */
export const MAX_AMOUNT_MINOR = 2_147_483_647;
export const MAX_HOURS_PER_WEEK = 80;
export const EQUITY_NOTE_MAX = 500;

/** The shape every compensation reader works from — the offer's own columns. */
export interface CompensationFields {
  currency: string | null;
  baseAmountMinor: number | null;
  basePeriod: string | null;
  signingBonusMinor: number | null;
  otherBonusMinor: number | null;
  equityNote: string | null;
  hoursPerWeek: number | null;
  contractType: string | null;
}

export const EMPTY_COMPENSATION: CompensationFields = {
  currency: null,
  baseAmountMinor: null,
  basePeriod: null,
  signingBonusMinor: null,
  otherBonusMinor: null,
  equityNote: null,
  hoursPerWeek: null,
  contractType: null,
};

/** Does this offer carry any structured figure at all? (The note alone does not count.) */
export function hasStructuredCompensation(c: Partial<CompensationFields> | null | undefined): boolean {
  if (!c) return false;
  return c.baseAmountMinor != null || c.signingBonusMinor != null || c.otherBonusMinor != null
    || !!c.equityNote || c.hoursPerWeek != null || !!c.contractType;
}

/**
 * Why a set of compensation fields cannot be saved, or null when it can. The
 * same rule for POST and PATCH: an amount needs a currency and a period to
 * mean anything, a bonus needs a currency, and the whitelists are closed.
 */
export type CompensationProblem =
  | 'currency_required'
  | 'period_required'
  | 'unknown_currency'
  | 'unknown_period'
  | 'unknown_contract_type';

export function validateCompensation(c: Partial<CompensationFields>): CompensationProblem | null {
  if (c.currency != null && !isOfferCurrency(c.currency)) return 'unknown_currency';
  if (c.basePeriod != null && !isBasePeriod(c.basePeriod)) return 'unknown_period';
  if (c.contractType != null && !isContractType(c.contractType)) return 'unknown_contract_type';
  const anyAmount = c.baseAmountMinor != null || c.signingBonusMinor != null || c.otherBonusMinor != null;
  if (anyAmount && c.currency == null) return 'currency_required';
  if (c.baseAmountMinor != null && c.basePeriod == null) return 'period_required';
  return null;
}

/** Round half away from zero, the same rounding src/lib/roi.ts uses for money. */
function roundMinor(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Weeks in a year, for an hourly rate: 52 weeks × hours ÷ 12 months. */
const WEEKS_PER_YEAR = 52;

/**
 * The base pay as a monthly figure in minor units — FOR COMPARISON ONLY, never
 * stored. `null` when it cannot be derived: no amount, no period, or an hourly
 * rate without `hoursPerWeek` (a guess at 40 would present an assumption as a
 * fact, which is exactly what the benchmark must not do).
 */
export function normalizeToMonthlyMinor(c: Pick<CompensationFields, 'baseAmountMinor' | 'basePeriod' | 'hoursPerWeek'>): number | null {
  const amount = c.baseAmountMinor;
  if (amount == null || !Number.isFinite(amount)) return null;
  switch (c.basePeriod) {
    case 'MONTHLY':
      return roundMinor(amount);
    case 'YEARLY':
      return roundMinor(amount / 12);
    case 'HOURLY': {
      const hours = c.hoursPerWeek;
      if (hours == null || !(hours > 0)) return null;
      return roundMinor((amount * hours * WEEKS_PER_YEAR) / 12);
    }
    default:
      return null;
  }
}

// ── Benchmark ────────────────────────────────────────────────────────────────

/**
 * The smallest bucket the benchmark will describe. A median over two offers is
 * those two people's pay with a label on it; five is the floor below which the
 * bucket is returned with `null` statistics and `suppressed: true` — present,
 * so the screen can say "not enough data", never silently omitted.
 */
export const BENCHMARK_MIN_BUCKET = 5;

export interface BenchmarkStats {
  count: number;
  medianMonthlyMinor: number | null;
  p25MonthlyMinor: number | null;
  p75MonthlyMinor: number | null;
  suppressed: boolean;
}

/**
 * Quantile by linear interpolation between order statistics (the R-7 /
 * spreadsheet PERCENTILE definition) on an ALREADY SORTED ascending array,
 * rounded to a whole minor unit. Exported for the tests; callers use
 * `benchmarkStats`.
 */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return roundMinor(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

export function benchmarkStats(monthlyMinor: readonly number[], minBucket: number = BENCHMARK_MIN_BUCKET): BenchmarkStats {
  const count = monthlyMinor.length;
  if (count < minBucket) {
    return { count, medianMonthlyMinor: null, p25MonthlyMinor: null, p75MonthlyMinor: null, suppressed: true };
  }
  const sorted = [...monthlyMinor].sort((a, b) => a - b);
  return {
    count,
    medianMonthlyMinor: quantileSorted(sorted, 0.5),
    p25MonthlyMinor: quantileSorted(sorted, 0.25),
    p75MonthlyMinor: quantileSorted(sorted, 0.75),
    suppressed: false,
  };
}

/** One accepted offer, reduced to what the benchmark groups and measures. */
export interface BenchmarkInput {
  position: string;
  currency: string;
  contractType: string | null;
  monthlyMinor: number;
}

export interface BenchmarkBucket extends BenchmarkStats {
  position: string;
  currency: string;
  /** Present only when grouping by contract type; `null` for offers without one. */
  contractType?: string | null;
}

/** "Frontend Developer", "frontend developer " and "FRONTEND  DEVELOPER" are one position. */
export function normalizePosition(position: string): string {
  return position.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Group accepted offers into benchmark buckets. A bucket is one position in ONE
 * currency — the model never converts (see the CURRENCY note in roi.ts), so the
 * same title paid in EUR and in TRY is two buckets. With `byContractType` the
 * contract type is a third key. Buckets are sorted by position, then currency,
 * then contract type, so the output is deterministic for the same input.
 */
export function benchmarkBuckets(rows: readonly BenchmarkInput[], opts: { byContractType?: boolean; minBucket?: number } = {}): BenchmarkBucket[] {
  const groups = new Map<string, { position: string; currency: string; contractType: string | null; values: number[] }>();
  for (const row of rows) {
    const position = normalizePosition(row.position);
    if (!position) continue;
    const currency = row.currency.trim().toUpperCase();
    const contractType = opts.byContractType ? row.contractType ?? null : null;
    const key = `${position}\u0000${currency}\u0000${contractType ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { position, currency, contractType, values: [] };
      groups.set(key, group);
    }
    group.values.push(row.monthlyMinor);
  }
  const buckets: BenchmarkBucket[] = [];
  for (const group of groups.values()) {
    const stats = benchmarkStats(group.values, opts.minBucket);
    const bucket: BenchmarkBucket = { position: group.position, currency: group.currency, ...stats };
    if (opts.byContractType) bucket.contractType = group.contractType;
    buckets.push(bucket);
  }
  return buckets.sort((a, b) =>
    a.position.localeCompare(b.position) || a.currency.localeCompare(b.currency) || (a.contractType ?? '').localeCompare(b.contractType ?? ''),
  );
}
