// The affiliate commission engine (docs/affiliate-module.md, "The commission plan").
//
// PURE and dependency-free: no database, no clock, no I/O. The rule is generic;
// every number comes from the organisation's commission plan, which is DATA
// (AffiliateProgramSettings). Nothing in this file mirrors a real contract, and
// the tests use synthetic plans only (CLAUDE.md, "Tenant names never enter this
// repo").
//
// The engine evaluates a partner's WHOLE payment history at once
// (`evaluatePartner`). That is deliberate: a customer's ordinal is decided by
// first-payment date, so a back-dated entry can change what later payments are
// worth. Re-running the same pure function over the full history gives the one
// correct answer; the payment writer compares it with the stored commissions
// and changes only those not yet PAID.
//
// Money is integer minor units with an ISO currency. Never a float.

// The ceiling of every amount — a payment, a tier, a commission. It is the signed
// 32-bit `Int` the columns use, so a value the plan accepts can always be stored;
// amount × bps (≤ 2.2e13) stays far below 2^53.
export const MAX_AMOUNT_MINOR = 2_147_483_647;
export const MAX_TIERS = 20;

export type BoundaryCustomer = 'TIER' | 'PERCENT';
export type AfterNotice = 'STOP_ALL' | 'RUN_OUT';

export interface TierBand {
  /** Inclusive upper bound of the customer's first payment, in minor units. */
  upToMinor: number;
  /** The one-off commission for a first payment in this band, in minor units. */
  commissionMinor: number;
}

export interface CommissionPlan {
  /** ISO 4217 code; every amount of the plan, and every payment it judges, is in it. */
  currency: string;
  /** Ascending by `upToMinor`. May be empty: then every tier commission is `topCommissionMinor`. */
  tiers: TierBand[];
  /** Tier commission for a first payment above the last band. */
  topCommissionMinor: number;
  /** Percent phase rate in basis points (100 = 1 %). 0 = no percent phase. */
  percentBps: number;
  /** The Nth paying customer whose first payment starts the percent phase. Null = never. */
  switchAtCustomer: number | null;
  /** What the Nth customer's own first payment earns. */
  boundaryCustomer: BoundaryCustomer;
  /** Months from a customer's first payment during which it earns percent. Null = no limit. */
  windowMonths: number | null;
  /** Days after a payment by which its commission is due (informational). */
  payoutDays: number;
  /** What accrues once a partner's termination has taken effect. */
  afterNotice: AfterNotice;
  /**
   * Month-aligned phases (#3845): the percent phase starts at the beginning of
   * the month in which the Nth customer first paid, and a customer's window runs
   * `windowMonths` calendar months from the beginning of its first paying month.
   * False (every plan stored before #3845): both start at the payment itself.
   */
  monthAligned: boolean;
  /** IANA zone whose calendar months `monthAligned` uses. Default Europe/Berlin. */
  timeZone: string;
}

export const DEFAULT_PLAN_TIME_ZONE = 'Europe/Berlin';

/** Whether `tz` is an IANA zone this runtime knows. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface PlanIssue {
  field: string;
  code: 'required' | 'type' | 'range' | 'order' | 'combination';
}

export type PlanParseResult = { ok: true; plan: CommissionPlan } | { ok: false; issues: PlanIssue[] };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function intIn(issues: PlanIssue[], field: string, v: unknown, min: number, max: number): number {
  if (v === undefined || v === null) {
    issues.push({ field, code: 'required' });
    return 0;
  }
  if (!isInt(v)) {
    issues.push({ field, code: 'type' });
    return 0;
  }
  if (v < min || v > max) issues.push({ field, code: 'range' });
  return v;
}

function nullableIntIn(issues: PlanIssue[], field: string, v: unknown, min: number, max: number): number | null {
  if (v === null || v === undefined) return null;
  return intIn(issues, field, v, min, max);
}

function oneOf<T extends string>(issues: PlanIssue[], field: string, v: unknown, values: readonly T[]): T {
  if (v === undefined || v === null) {
    issues.push({ field, code: 'required' });
    return values[0];
  }
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    issues.push({ field, code: 'type' });
    return values[0];
  }
  return v as T;
}

/**
 * Validates an untrusted plan (a request body, a JSON column). Returns every
 * problem at once so a settings form can mark all fields in one round.
 */
export function parseCommissionPlan(input: unknown): PlanParseResult {
  const issues: PlanIssue[] = [];
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  let currency = '';
  if (o.currency === undefined || o.currency === null) issues.push({ field: 'currency', code: 'required' });
  else if (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency)) issues.push({ field: 'currency', code: 'type' });
  else currency = o.currency;

  const tiers: TierBand[] = [];
  if (!Array.isArray(o.tiers)) {
    issues.push({ field: 'tiers', code: o.tiers === undefined ? 'required' : 'type' });
  } else if (o.tiers.length > MAX_TIERS) {
    issues.push({ field: 'tiers', code: 'range' });
  } else {
    o.tiers.forEach((raw, i) => {
      const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const upToMinor = intIn(issues, `tiers.${i}.upToMinor`, t.upToMinor, 0, MAX_AMOUNT_MINOR);
      const commissionMinor = intIn(issues, `tiers.${i}.commissionMinor`, t.commissionMinor, 0, MAX_AMOUNT_MINOR);
      if (i > 0 && upToMinor <= tiers[i - 1].upToMinor) issues.push({ field: `tiers.${i}.upToMinor`, code: 'order' });
      tiers.push({ upToMinor, commissionMinor });
    });
  }

  const topCommissionMinor = intIn(issues, 'topCommissionMinor', o.topCommissionMinor, 0, MAX_AMOUNT_MINOR);
  const percentBps = intIn(issues, 'percentBps', o.percentBps, 0, 10_000);
  const switchAtCustomer = nullableIntIn(issues, 'switchAtCustomer', o.switchAtCustomer, 1, 100_000);
  const boundaryCustomer = oneOf(issues, 'boundaryCustomer', o.boundaryCustomer, ['TIER', 'PERCENT'] as const);
  const windowMonths = nullableIntIn(issues, 'windowMonths', o.windowMonths, 1, 600);
  const payoutDays = intIn(issues, 'payoutDays', o.payoutDays, 0, 365);
  const afterNotice = oneOf(issues, 'afterNotice', o.afterNotice, ['STOP_ALL', 'RUN_OUT'] as const);
  // Both are optional: a plan stored before #3845 reads as not month-aligned, in Berlin time.
  let monthAligned = false;
  if (o.monthAligned !== undefined && o.monthAligned !== null) {
    if (typeof o.monthAligned !== 'boolean') issues.push({ field: 'monthAligned', code: 'type' });
    else monthAligned = o.monthAligned;
  }
  let timeZone = DEFAULT_PLAN_TIME_ZONE;
  if (o.timeZone !== undefined && o.timeZone !== null) {
    if (!isTimeZone(o.timeZone)) issues.push({ field: 'timeZone', code: 'type' });
    else timeZone = o.timeZone;
  }

  // A switch into a 0 % phase would silently end every commission after it.
  if (switchAtCustomer !== null && percentBps === 0) issues.push({ field: 'percentBps', code: 'combination' });

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    plan: {
      currency,
      tiers,
      topCommissionMinor,
      percentBps,
      switchAtCustomer,
      boundaryCustomer,
      windowMonths,
      payoutDays,
      afterNotice,
      monthAligned,
      timeZone,
    },
  };
}

/** The tier commission for a customer's first payment. */
export function tierCommissionMinor(plan: CommissionPlan, firstPaymentMinor: number): number {
  for (const band of plan.tiers) {
    if (firstPaymentMinor <= band.upToMinor) return band.commissionMinor;
  }
  return plan.topCommissionMinor;
}

/** `percentBps` of a payment, rounded half up. Integer arithmetic only. */
export function percentCommissionMinor(plan: CommissionPlan, paymentMinor: number): number {
  return Math.floor((paymentMinor * plan.percentBps + 5_000) / 10_000);
}

/**
 * `from` plus `months` calendar months in UTC, clamped to the target month's
 * last day (31 Jan + 1 month = 28/29 Feb, never 2/3 Mar).
 */
export function addMonthsUtc(from: Date, months: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(from.getUTCDate(), lastDay),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

// ── Calendar months in a zone (#3845) ───────────────────────────────────────
// Intl only, no library: the wall-clock parts of an instant in `tz`, and the
// instant of a local midnight on the 1st of a month. DST is handled by reading
// the zone's offset at the candidate instant and correcting once more.

function zoneParts(at: Date, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: n('year'), m: n('month'), d: n('day'), h: n('hour'), mi: n('minute'), s: n('second') };
}

/** The zone's offset from UTC at `at`, in milliseconds (positive east of UTC). */
function zoneOffsetMs(at: Date, tz: string): number {
  const p = zoneParts(at, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant of local midnight on the 1st of month `month0` (0-based, may overflow) of `year` in `tz`. */
function zonedMonthStart(year: number, month0: number, tz: string): Date {
  const wall = Date.UTC(year, month0, 1);
  let t = wall - zoneOffsetMs(new Date(wall), tz);
  t = wall - zoneOffsetMs(new Date(t), tz);
  return new Date(t);
}

/** The beginning of the calendar month (in `tz`) that contains `at`, plus `addMonths` months. */
export function monthStartInZone(at: Date, tz: string, addMonths = 0): Date {
  const p = zoneParts(at, tz);
  return zonedMonthStart(p.y, p.m - 1 + addMonths, tz);
}

/**
 * When a customer's percent window ends (exclusive): its first valid payment plus
 * the plan's `windowMonths` — from the beginning of that payment's month when the
 * plan is month-aligned (#3845); null when the plan sets no limit. The ONE place
 * this date is computed — the engine below, the partner's window notice
 * (src/lib/affiliateWindowNoticeRule.ts, #3556) and the portal all read it here,
 * so a mail and a screen can never name two different days.
 */
export function customerWindowEndsAt(
  plan: Pick<CommissionPlan, 'windowMonths'> & Partial<Pick<CommissionPlan, 'monthAligned' | 'timeZone'>>,
  firstPaymentAt: Date,
): Date | null {
  if (plan.windowMonths === null) return null;
  return plan.monthAligned
    ? monthStartInZone(firstPaymentAt, plan.timeZone ?? DEFAULT_PLAN_TIME_ZONE, plan.windowMonths)
    : addMonthsUtc(firstPaymentAt, plan.windowMonths);
}

export interface PaymentFact {
  id: string;
  customerId: string;
  /** What the customer paid (gross); the percent phase earns on it. */
  amountMinor: number;
  /**
   * The list price of the month's transaction count (#3845), when known. A first
   * payment's tier commission is chosen by it; null/absent falls back to `amountMinor`.
   */
  listAmountMinor?: number | null;
  currency: string;
  receivedAt: Date;
}

export interface PartnerFacts {
  /** When the partner's termination takes effect; null while the partner is active. */
  noticeEffectiveAt: Date | null;
}

export type NoneReason =
  | 'NOT_A_PAYMENT' // zero, negative, non-integer or out of range
  | 'CURRENCY_MISMATCH' // the payment is not in the plan's currency
  | 'NEW_CUSTOMER_AFTER_NOTICE' // the customer first paid after the termination took effect
  | 'AFTER_NOTICE' // STOP_ALL: nothing accrues after the termination took effect
  | 'BEFORE_SWITCH' // a later payment before the percent phase started
  | 'WINDOW_CLOSED'; // past the customer's percent window

export type PaymentOutcome =
  | { kind: 'TIER' | 'PERCENT'; amountMinor: number }
  | { kind: 'NONE'; reason: NoneReason };

export interface PaymentEvaluation {
  paymentId: string;
  customerId: string;
  outcome: PaymentOutcome;
  /** This customer's ordinal among the partner's eligible paying customers; null if none. */
  customerOrdinal: number | null;
  /** End of the customer's percent window (exclusive); null without a window or ordinal. */
  windowEndsAt: Date | null;
  /** When the commission is due (receivedAt + payoutDays); null when nothing accrues. */
  dueAt: Date | null;
}

export interface PartnerEvaluation {
  /** The instant the percent phase started; null if it has not. */
  switchedAt: Date | null;
  /** Eligible paying customers, in ordinal order (1-based index + 1). */
  customerOrder: string[];
  /** One entry per input payment, in the input order. */
  payments: PaymentEvaluation[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const byTimeThenId = (a: PaymentFact, b: PaymentFact) =>
  a.receivedAt.getTime() - b.receivedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function isPayment(plan: CommissionPlan, p: PaymentFact): NoneReason | null {
  if (!isInt(p.amountMinor) || p.amountMinor <= 0 || p.amountMinor > MAX_AMOUNT_MINOR) return 'NOT_A_PAYMENT';
  if (p.currency !== plan.currency) return 'CURRENCY_MISMATCH';
  return null;
}

/**
 * What every payment of one partner is worth under `plan`.
 *
 * Semantics (docs/affiliate-module.md, "Engine semantics"):
 * - A customer is a paying customer from its first valid payment. Customers are
 *   numbered by that first payment's `receivedAt` (ties broken by payment id),
 *   never by entry order. A customer whose first payment falls at or after the
 *   termination gets no ordinal and earns nothing.
 * - Before the switch, a customer's first payment earns one tier commission;
 *   its later payments earn nothing.
 * - The switch instant is the first payment of customer `switchAtCustomer` — or,
 *   for a month-aligned plan (#3845), the beginning of that payment's month in
 *   the plan's zone, so the month's earlier payments earn percent too.
 *   That payment earns per `boundaryCustomer`; customers after it earn percent
 *   on their first payment. From the switch instant on (inclusive), every
 *   payment of every eligible customer earns percent inside that customer's
 *   window. Payments before the switch are never revisited.
 * - At or after the termination: STOP_ALL accrues nothing; RUN_OUT lets the
 *   eligible customers keep earning under the rules above.
 */
export function evaluatePartner(plan: CommissionPlan, partner: PartnerFacts, payments: PaymentFact[]): PartnerEvaluation {
  const notice = partner.noticeEffectiveAt?.getTime() ?? null;
  const sorted = [...payments].sort(byTimeThenId);

  // First valid payment per customer.
  const firstOf = new Map<string, PaymentFact>();
  for (const p of sorted) {
    if (isPayment(plan, p) === null && !firstOf.has(p.customerId)) firstOf.set(p.customerId, p);
  }

  // Ordinals over eligible customers (first paid before the termination).
  const firsts = [...firstOf.values()].sort(byTimeThenId);
  const eligible = firsts.filter((p) => notice === null || p.receivedAt.getTime() < notice);
  const ordinal = new Map<string, number>();
  eligible.forEach((p, i) => ordinal.set(p.customerId, i + 1));

  const n = plan.switchAtCustomer;
  const switchPayment = n !== null && eligible.length >= n ? eligible[n - 1] : null;
  // Month-aligned (#3845): from the beginning of the month the Nth customer first paid in.
  const switchedAt = switchPayment ? (plan.monthAligned ? monthStartInZone(switchPayment.receivedAt, plan.timeZone) : switchPayment.receivedAt) : null;

  const evaluate = (p: PaymentFact): PaymentEvaluation => {
    const base = { paymentId: p.id, customerId: p.customerId };
    const none = (reason: NoneReason, ord: number | null = null, windowEndsAt: Date | null = null): PaymentEvaluation => ({
      ...base,
      outcome: { kind: 'NONE', reason },
      customerOrdinal: ord,
      windowEndsAt,
      dueAt: null,
    });

    const invalid = isPayment(plan, p);
    if (invalid) return none(invalid, ordinal.get(p.customerId) ?? null);

    const ord = ordinal.get(p.customerId);
    if (ord === undefined) return none('NEW_CUSTOMER_AFTER_NOTICE');

    const first = firstOf.get(p.customerId)!;
    const windowEndsAt = customerWindowEndsAt(plan, first.receivedAt);
    const at = p.receivedAt.getTime();

    if (notice !== null && at >= notice && plan.afterNotice === 'STOP_ALL') return none('AFTER_NOTICE', ord, windowEndsAt);

    const earn = (kind: 'TIER' | 'PERCENT', amountMinor: number): PaymentEvaluation => ({
      ...base,
      outcome: { kind, amountMinor },
      customerOrdinal: ord,
      windowEndsAt,
      dueAt: new Date(at + plan.payoutDays * DAY_MS),
    });
    const percent = (): PaymentEvaluation => {
      if (windowEndsAt !== null && at >= windowEndsAt.getTime()) return none('WINDOW_CLOSED', ord, windowEndsAt);
      return earn('PERCENT', percentCommissionMinor(plan, p.amountMinor));
    };

    // A first payment's tier is chosen by the month's list price when known (#3845).
    const tierBase = p.listAmountMinor ?? p.amountMinor;
    if (first.id === p.id) {
      // Customers before the Nth keep their one-off commission even when they first
      // paid in the month the percent phase starts (#3845).
      if (n === null || ord < n) return earn('TIER', tierCommissionMinor(plan, tierBase));
      if (ord === n && plan.boundaryCustomer === 'TIER') return earn('TIER', tierCommissionMinor(plan, tierBase));
      return percent();
    }

    if (switchedAt === null || at < switchedAt.getTime()) return none('BEFORE_SWITCH', ord, windowEndsAt);
    return percent();
  };

  return {
    switchedAt,
    customerOrder: eligible.map((p) => p.customerId),
    payments: payments.map(evaluate),
  };
}
