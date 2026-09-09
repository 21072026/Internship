// The billable unit, as a rule — one definition, in one place (#1750).
//
// THE PUBLISHED DEFINITION, verbatim, because this is the sentence on the
// pricing page and the code below has to be the code we can point at:
//
//   "a relation in ACTIVE state with any logged activity in the calendar
//    month; paused, benched and completed pairs are not counted"
//
// Every word of it is load-bearing:
//
//   · ACTIVE state — a billable state, read from BILLABLE_RELATION_STATES
//     below. That constant is an ALLOWLIST, so a lifecycle state added later
//     (PAUSED, BENCHED) is non-billable the moment it exists, without anybody
//     remembering to exclude it in seven queries. The half of the sentence
//     that promises "paused and benched are not counted" therefore becomes
//     true automatically rather than being hardcoded to today's two values.
//   · any logged activity — at least one row in ANY of the per-relation
//     activity signals (ACTIVITY_SIGNALS below), which is why a dormant pair
//     needs no special case: `dormantSince` is a stamp on a relation that has
//     gone quiet, and a quiet relation has no activity row in the month. There
//     is deliberately no reference to it here.
//   · calendar month — UTC month boundaries, from periodRange() below. Nobody
//     computes their own, so no caller can drift the invoice by a timezone.
//
// This module is the RULE and is deliberately dependency-free (no `@/`
// imports, no Prisma types) so a plain `node --experimental-strip-types` test
// can import it — scripts/test/metering.test.mjs. The queries that feed it
// live in lib/metering.ts, which re-exports everything here, so a caller needs
// exactly one import and there is exactly one meter in this repo.

/** The published definition, so a UI or a doc renders the same words the code enforces. */
export const ACTIVE_MATCHED_PAIR_DEFINITION =
  'a relation in ACTIVE state with any logged activity in the calendar month; ' +
  'paused, benched and completed pairs are not counted';

/**
 * The relation states we charge for. An ALLOWLIST, not a denylist: the day
 * `MentorshipStatus` grows PAUSED/BENCHED, those states are excluded from the
 * invoice without a single query changing. Adding one to this array is the one
 * edit that makes a new state billable.
 *
 * Typed as plain strings rather than Prisma's `MentorshipStatus` so this file
 * stays dependency-free; lib/metering.ts is where it meets the generated enum.
 */
export const BILLABLE_RELATION_STATES = ['ACTIVE'] as const;
export type BillableRelationState = (typeof BILLABLE_RELATION_STATES)[number];

export function isBillableRelationState(status: string | null | undefined): boolean {
  return !!status && (BILLABLE_RELATION_STATES as readonly string[]).includes(status);
}

/**
 * The per-relation activity signals: the child relation on MentorshipRelation
 * and the timestamp column on it that says WHEN the activity happened.
 *
 * `InteractionLog.date` is the date of the interaction, not of the row's
 * creation — a meeting logged on Monday for Friday's conversation belongs to
 * Friday's month, which is what a customer reading their invoice expects.
 * Everything else has no such distinction and uses `createdAt`.
 *
 * `Message` is included with the caveat that only relation-stamped messages
 * carry a relationId (a project/group thread does not), so a pair that talks
 * only in a group channel is counted through its other signals. That is the
 * same boundary lib/lastContactRule.ts draws, for the same reason.
 */
export const ACTIVITY_SIGNALS = [
  { relation: 'interactions', at: 'date' },
  { relation: 'messages', at: 'createdAt' },
  { relation: 'meetings', at: 'createdAt' },
  { relation: 'meetingRequests', at: 'createdAt' },
  { relation: 'statusChanges', at: 'createdAt' },
  { relation: 'weeklyReports', at: 'createdAt' },
  { relation: 'goals', at: 'createdAt' },
] as const satisfies readonly { relation: string; at: string }[];

// ── Periods ─────────────────────────────────────────────────────────────────
// A period is a calendar month in UTC, written 'YYYY-MM'. UTC and not the
// tenant's zone: a month boundary that moves with a viewer's browser would
// make the same invoice line different for two people reading it, and there is
// no per-tenant billing zone to read anyway.

export type Period = string; // 'YYYY-MM'

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isPeriod(value: string): boolean {
  return PERIOD_RE.test(value);
}

/** The 'YYYY-MM' period a moment falls in (UTC). */
export function periodOf(at: Date): Period {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The period that is open right now. */
export function currentPeriod(now: Date = new Date()): Period {
  return periodOf(now);
}

/**
 * The half-open UTC window of a period: `gte` inclusive, `lt` exclusive.
 *
 * Half-open on purpose. A `lte` end-of-month is the classic off-by-one in
 * billing code — either it drops the last millisecond of the month or, written
 * as the 1st of the next month, it double-counts a row created exactly at
 * midnight into two invoices.
 */
export function periodRange(period: Period): { gte: Date; lt: Date } {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error(`Invalid billing period "${period}" — expected YYYY-MM`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  return {
    gte: new Date(Date.UTC(year, month - 1, 1)),
    // Month 12 rolls into January of the next year on its own: Date.UTC
    // normalises month index 12.
    lt: new Date(Date.UTC(year, month, 1)),
  };
}

/** The period before this one. December → the previous January-less year. */
export function previousPeriod(period: Period): Period {
  const { gte } = periodRange(period);
  return periodOf(new Date(Date.UTC(gte.getUTCFullYear(), gte.getUTCMonth() - 1, 1)));
}

/** The periods a nightly rollup refreshes: the open month and the one before it. */
export function rollupPeriods(now: Date = new Date()): [Period, Period] {
  const current = currentPeriod(now);
  return [current, previousPeriod(current)];
}

// ── Metrics ─────────────────────────────────────────────────────────────────
// Two shapes, and mixing them up is how a re-run doubles an invoice:
//
//   COMPUTED — the rollup recomputes the number from the domain tables and
//              writes it absolutely (`set`). Re-running a closed period writes
//              the same value again, which is what makes the job idempotent.
//   COUNTER  — incremented as the thing happens (a video room is created once
//              and cannot be recounted afterwards). The rollup never touches
//              these, precisely because an increment is not idempotent.

export type UsageMetric =
  | 'ACTIVE_MATCHED_PAIRS'
  | 'ADMIN_SEATS'
  | 'VIDEO_ROOM'
  | 'VIDEO_PARTICIPANT'
  | 'ACTIVE_PAIR_ACTIVITY';

export type MetricKind = 'COMPUTED' | 'COUNTER';

export const USAGE_METRICS: Record<UsageMetric, { kind: MetricKind; what: string }> = {
  // The billable unit. The definition above, and nothing else.
  ACTIVE_MATCHED_PAIRS: { kind: 'COMPUTED', what: ACTIVE_MATCHED_PAIR_DEFINITION },
  // The second metered number a customer sees on the same invoice.
  ADMIN_SEATS: { kind: 'COMPUTED', what: 'active ADMIN users of the org at the time of the rollup' },
  // JaaS MAU exposure: rooms created, and heads in them. Reported, never gated.
  VIDEO_ROOM: { kind: 'COUNTER', what: 'video rooms created in the period' },
  VIDEO_PARTICIPANT: { kind: 'COUNTER', what: 'invitees a created video room was for' },
  // Activity volume behind the pair count. NOT the pair count — one pair can
  // raise this fifty times in a month and is still one billable pair.
  ACTIVE_PAIR_ACTIVITY: { kind: 'COUNTER', what: 'activity signals logged against a relation' },
};

export function isUsageMetric(value: string): value is UsageMetric {
  return Object.prototype.hasOwnProperty.call(USAGE_METRICS, value);
}

/** The metrics the nightly rollup recomputes and overwrites, in report order. */
export const COMPUTED_METRICS = (Object.keys(USAGE_METRICS) as UsageMetric[]).filter(
  (m) => USAGE_METRICS[m].kind === 'COMPUTED',
);

// ── The rule, as a pure function ────────────────────────────────────────────
// The query in lib/metering.ts asks the database this same question in one
// round trip; this is the same rule over rows already in memory, so the
// boundary cases (active-but-quiet, completed-with-activity, dormant) can be
// pinned down by a unit test without a database.

export interface PairActivityRow {
  /** MentorshipRelation.status */
  status: string;
  /** Timestamps of every activity signal on this relation, any signal, any month. */
  activityAt: Date[];
}

export function isBillablePair(row: PairActivityRow, period: Period): boolean {
  if (!isBillableRelationState(row.status)) return false;
  const { gte, lt } = periodRange(period);
  return row.activityAt.some((at) => at >= gte && at < lt);
}

export function countBillablePairs(rows: PairActivityRow[], period: Period): number {
  return rows.reduce((n, row) => n + (isBillablePair(row, period) ? 1 : 0), 0);
}
