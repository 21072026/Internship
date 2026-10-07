// Product-usage rules (#2448, #2449) — dependency-free and unit-tested
// (scripts/test/usage-rule.test.mjs). The data is `CompanyUsage`: one row per
// account per calendar day, absolute counts (#2445). Prisma lives in the
// callers (src/lib/usageSignals.ts, src/lib/companyDetail.ts), never here.
//
// Two rules matter beyond the arithmetic:
//   * a day WITH a row whose count is 0 is "zero usage"; a day with NO row is
//     "no data". They are kept apart everywhere — on the chart, in the text
//     summary and in the signals — because a missing feed day is not a
//     customer who stopped working;
//   * signals only SHOW. Nothing here changes a stage or closes a record.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of a UTC day — the key `@db.Date` reads back as. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type UsageRow = { date: Date; transactions: number };
export type UsagePoint = { day: string; value: number | null };

/**
 * The last `days` UTC days ending with `end`'s day, oldest first: the row's
 * count where a row exists, `null` where none does.
 */
export function usageSeries(rows: readonly UsageRow[], end: Date, days = 90): UsagePoint[] {
  const byDay = new Map(rows.map((r) => [dayKey(r.date), r.transactions]));
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const out: UsagePoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(new Date(endDay - i * DAY_MS));
    out.push({ day, value: byDay.has(day) ? byDay.get(day)! : null });
  }
  return out;
}

export type UsageSummary = {
  daysWithData: number;
  total: number;
  max: number;
  /** Sum of the last 30 days that have data; null when none of them do. */
  last30: number | null;
  /** The 30 days before that, same rule. */
  prev30: number | null;
};

export function usageSummary(series: readonly UsagePoint[]): UsageSummary {
  const sum = (pts: readonly UsagePoint[]) => {
    const known = pts.filter((p) => p.value !== null);
    return known.length === 0 ? null : known.reduce((s, p) => s + (p.value as number), 0);
  };
  const known = series.filter((p) => p.value !== null) as { day: string; value: number }[];
  return {
    daysWithData: known.length,
    total: known.reduce((s, p) => s + p.value, 0),
    max: known.reduce((m, p) => Math.max(m, p.value), 0),
    last30: sum(series.slice(-30)),
    prev30: sum(series.slice(-60, -30)),
  };
}

// ── Signals for the attention queue (#2449) ─────────────────────────────────

export type UsageSignalSettings = {
  /** Drop, in percent of the earlier window, that raises `usage_drop`. */
  thresholdPct: number;
  /** History an account needs: two windows of half this length are compared. */
  baselineDays: number;
  /** Days into a trial after which no usage at all raises `trial_inactive`. */
  trialDays: number;
};

export const USAGE_SIGNAL_DEFAULTS: UsageSignalSettings = { thresholdPct: 40, baselineDays: 60, trialDays: 7 };

/** Parse the three settings, falling back per field on anything unusable. */
export function usageSignalSettings(raw: { thresholdPct?: string; baselineDays?: string; trialDays?: string }): UsageSignalSettings {
  const int = (v: string | undefined, min: number, max: number, fallback: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    thresholdPct: int(raw.thresholdPct, 1, 100, USAGE_SIGNAL_DEFAULTS.thresholdPct),
    baselineDays: int(raw.baselineDays, 14, 365, USAGE_SIGNAL_DEFAULTS.baselineDays),
    trialDays: int(raw.trialDays, 1, 90, USAGE_SIGNAL_DEFAULTS.trialDays),
  };
}

/** The two comparison windows for `now`, as [start, end) instants. */
export function dropWindows(now: Date, baselineDays: number) {
  const half = Math.floor(baselineDays / 2);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS;
  return {
    recent: { from: new Date(end - half * DAY_MS), to: new Date(end) },
    prior: { from: new Date(end - 2 * half * DAY_MS), to: new Date(end - half * DAY_MS) },
  };
}

export type DropVerdict = 'drop' | 'ok' | 'insufficient_history';

/**
 * Has this account's usage dropped? `firstRowAt` is its oldest usage row ever:
 * an account whose data does not reach back over the whole baseline is
 * `insufficient_history` — left out and counted, never guessed at. An earlier
 * window of zero cannot drop.
 */
export function usageDropVerdict(input: {
  recent: number;
  prior: number;
  firstRowAt: Date | null;
  now: Date;
  settings: UsageSignalSettings;
}): DropVerdict {
  const { prior } = dropWindows(input.now, input.settings.baselineDays);
  if (!input.firstRowAt || input.firstRowAt.getTime() > prior.from.getTime()) return 'insufficient_history';
  if (input.prior <= 0) return 'ok';
  const dropPct = ((input.prior - input.recent) / input.prior) * 100;
  return dropPct >= input.settings.thresholdPct ? 'drop' : 'ok';
}

/**
 * A trial nobody started using: `trialDays` or more since it began and no usage
 * at all since then. False before that day, and for a record with no start.
 */
export function trialInactive(input: { trialStartedAt: Date | null; usageSinceStart: number; now: Date; settings: UsageSignalSettings }): boolean {
  if (!input.trialStartedAt) return false;
  const elapsed = input.now.getTime() - input.trialStartedAt.getTime();
  return elapsed >= input.settings.trialDays * DAY_MS && input.usageSinceStart <= 0;
}
