// Per-API-key period quota and the RateLimit headers (#2010) — the pure half.
// Dependency-free, unit-tested in scripts/test/api-key-quota.test.mjs. The
// accounting (tally + batched flush) is src/lib/apiKeyQuota.ts; the door that
// applies both is withApiKey() in src/lib/apiKey.ts.
//
// Two limits sit on every key-authenticated request:
//   • the per-minute window (rateLimit.ts, keyed `key:<id>` — #1546's keying,
//     consumed, not duplicated), refused as `429 rate_limited`;
//   • the period allowance, when the key has one (`quotaPeriod` + `quotaLimit`),
//     refused as `429 quota_exceeded` with the reset instant.
// A key with no quota is unlimited by period and still limited per minute.
// A session-authenticated request never reaches any of this: only withApiKey
// calls it.

export const QUOTA_PERIODS = ['day', 'month'] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

/** The largest allowance an admin may set — MySQL INT, with headroom. */
export const MAX_QUOTA_LIMIT = 100_000_000;

export function isQuotaPeriod(value: unknown): value is QuotaPeriod {
  return typeof value === 'string' && (QUOTA_PERIODS as readonly string[]).includes(value);
}

/** The UTC calendar period `now` falls in: [start, end). Usage of an unmetered key is tallied by month. */
export function periodBounds(period: QuotaPeriod, now: Date = new Date()): { start: Date; end: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (period === 'day') {
    const start = new Date(Date.UTC(y, m, now.getUTCDate()));
    return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
  }
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

/** One limit's state, in the units the headers speak: a count and a reset instant. */
export interface LimitState {
  limit: number;
  remaining: number;
  /** Epoch ms when the window or period resets. */
  resetAt: number;
}

/**
 * The limit to advertise when several apply: the one closest to exhaustion
 * (fewest remaining; on a tie, the one that resets later — it binds longer).
 * This is what the IETF RateLimit header draft asks for.
 */
export function bindingLimit(states: (LimitState | null | undefined)[]): LimitState | null {
  const live = states.filter((s): s is LimitState => !!s);
  if (!live.length) return null;
  return live.reduce((a, b) => (b.remaining < a.remaining || (b.remaining === a.remaining && b.resetAt > a.resetAt) ? b : a));
}

/** `RateLimit-Limit` / `-Remaining` / `-Reset` (seconds until reset). */
export function rateLimitHeaders(state: LimitState, now: number = Date.now()): Record<string, string> {
  return {
    'RateLimit-Limit': String(state.limit),
    'RateLimit-Remaining': String(Math.max(0, state.remaining)),
    'RateLimit-Reset': String(Math.max(0, Math.ceil((state.resetAt - now) / 1000))),
  };
}

/**
 * The quota decision for one request: `used` is what the period has already
 * consumed (before this request). Refused when the allowance is spent; a key
 * with no allowance is never refused here.
 */
export function quotaDecision(used: number, limit: number | null): { ok: boolean; remainingAfter: number | null } {
  if (limit === null) return { ok: true, remainingAfter: null };
  if (used >= limit) return { ok: false, remainingAfter: 0 };
  return { ok: true, remainingAfter: limit - used - 1 };
}

/** Validate an admin's quota input: both set, or both cleared. */
export function parseQuotaInput(period: unknown, limit: unknown): { quotaPeriod: QuotaPeriod | null; quotaLimit: number | null } | null {
  if ((period === null || period === undefined || period === '') && (limit === null || limit === undefined || limit === '')) return { quotaPeriod: null, quotaLimit: null };
  if (!isQuotaPeriod(period)) return null;
  const n = typeof limit === 'string' ? Number(limit) : limit;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_QUOTA_LIMIT) return null;
  return { quotaPeriod: period, quotaLimit: n };
}
