// Per-API-key period quota — the accounting (#2010). Server-only. The rules
// (periods, the decision, the headers) are src/lib/apiKeyQuotaRules.ts.
//
// NO DATABASE WRITE PER REQUEST. Each process keeps a tally of the requests it
// has let through per (key, period) and flushes it every FLUSH_MS — or sooner,
// once a key's tally reaches FLUSH_AT — as ONE atomic `increment` upsert into
// `ApiKeyUsage`. The decision reads the stored count (cached for CACHE_MS) plus
// this process's unflushed tally, so:
//   • replicas add up: each increments the same row, nobody overwrites;
//   • a restart loses at most one unflushed window of counting;
//   • the overshoot is bounded and known — with N replicas a key can exceed its
//     allowance by at most what the others let through inside one CACHE_MS
//     window. For a period quota (a day, a month) that is noise; the per-minute
//     limiter is the burst control.
// Reads are bounded the same way: at most one indexed lookup per key per
// CACHE_MS per process.
//
// Every key-authenticated request is tallied — a key without a quota by month —
// so the admin key list can show what each integration actually uses.

import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { periodBounds, quotaDecision, type LimitState, type QuotaPeriod } from '@/lib/apiKeyQuotaRules';

const FLUSH_MS = 5_000;
const FLUSH_AT = 100;
const CACHE_MS = 5_000;

interface Tally {
  apiKeyId: string;
  orgId: string | null;
  periodStart: Date;
  n: number;
}

// ONE tally per process, not per module instance. `next dev` compiles each
// route into its own module graph, so module-level maps gave the /api/v1 door
// and the admin key list two different tallies there: the list read 0 for a
// request the door had just counted. A production build shares one instance,
// which is why only the dev server showed it; pinned on globalThis (the
// prisma.ts pattern) the two are the same everywhere.
interface QuotaState {
  tallies: Map<string, Tally>;
  stored: Map<string, { count: number; fetchedAt: number }>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<void> | null;
}
const globalForQuota = globalThis as unknown as { apiKeyQuota: QuotaState | undefined };
const state: QuotaState = (globalForQuota.apiKeyQuota ??= { tallies: new Map(), stored: new Map(), flushTimer: null, flushing: null });
const { tallies, stored } = state;

const slot = (apiKeyId: string, periodStart: Date) => `${apiKeyId}|${periodStart.toISOString()}`;

async function storedCount(apiKeyId: string, periodStart: Date, now: number): Promise<number> {
  const k = slot(apiKeyId, periodStart);
  const hit = stored.get(k);
  if (hit && now - hit.fetchedAt < CACHE_MS) return hit.count;
  const row = await prisma.apiKeyUsage
    .findUnique({ where: { apiKeyId_periodStart: { apiKeyId, periodStart } }, select: { requests: true } })
    .catch(() => null);
  const count = row?.requests ?? hit?.count ?? 0;
  stored.set(k, { count, fetchedAt: now });
  return count;
}

/** Write every tally as one increment per (key, period). Never throws; a failed write is put back. */
export async function flushApiKeyUsage(): Promise<void> {
  if (state.flushing) return state.flushing;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  const batch = [...tallies.values()];
  tallies.clear();
  state.flushing = (async () => {
    for (const t of batch) {
      try {
        // Under the key's own org: the timer inherits whichever request
        // scheduled it, and the tenant middleware must scope THIS row's org.
        const row = await runWithOrg(t.orgId, () =>
          prisma.apiKeyUsage.upsert({
            where: { apiKeyId_periodStart: { apiKeyId: t.apiKeyId, periodStart: t.periodStart } },
            create: { apiKeyId: t.apiKeyId, orgId: t.orgId, periodStart: t.periodStart, requests: t.n },
            update: { requests: { increment: t.n } },
            select: { requests: true },
          }),
        );
        stored.set(slot(t.apiKeyId, t.periodStart), { count: row.requests, fetchedAt: Date.now() });
      } catch (error) {
        // A deleted key (cascade) has nowhere to go; anything else is retried next flush.
        const missing = (error as { code?: string }).code === 'P2003' || (error as { code?: string }).code === 'P2025';
        if (!missing) {
          const k = slot(t.apiKeyId, t.periodStart);
          const back = tallies.get(k);
          tallies.set(k, back ? { ...back, n: back.n + t.n } : t);
          console.error('[api-key-quota] flush failed; kept for the next one', { apiKeyId: t.apiKeyId, error: String(error) });
        }
      }
    }
  })().finally(() => {
    state.flushing = null;
    if (tallies.size && !state.flushTimer) scheduleFlush();
  });
  return state.flushing;
}

function scheduleFlush() {
  if (state.flushTimer) return;
  const timer = setTimeout(() => {
    state.flushTimer = null;
    void flushApiKeyUsage();
  }, FLUSH_MS);
  timer.unref?.();
  state.flushTimer = timer;
}

export interface QuotaKey {
  id: string;
  orgId: string | null;
  quotaPeriod: string | null;
  quotaLimit: number | null;
}

/**
 * Count this request against the key's period, or refuse it. Returns the
 * quota's header state (null for a key without a quota) and, when refused, the
 * reset instant. A refused request is not counted.
 */
export async function consumeApiKeyQuota(key: QuotaKey, at: Date = new Date()): Promise<{ ok: boolean; state: LimitState | null; resetAt: Date }> {
  const limited = key.quotaLimit !== null && (key.quotaPeriod === 'day' || key.quotaPeriod === 'month');
  const period: QuotaPeriod = limited ? (key.quotaPeriod as QuotaPeriod) : 'month';
  const { start, end } = periodBounds(period, at);
  const k = slot(key.id, start);
  const now = at.getTime();
  const used = (await storedCount(key.id, start, now)) + (tallies.get(k)?.n ?? 0);
  const decision = quotaDecision(used, limited ? key.quotaLimit : null);
  if (!decision.ok) {
    return { ok: false, state: { limit: key.quotaLimit as number, remaining: 0, resetAt: end.getTime() }, resetAt: end };
  }
  const t = tallies.get(k) ?? { apiKeyId: key.id, orgId: key.orgId, periodStart: start, n: 0 };
  t.n += 1;
  tallies.set(k, t);
  if (t.n >= FLUSH_AT) void flushApiKeyUsage();
  else scheduleFlush();
  return {
    ok: true,
    state: limited ? { limit: key.quotaLimit as number, remaining: decision.remainingAfter ?? 0, resetAt: end.getTime() } : null,
    resetAt: end,
  };
}

/**
 * Requests in each key's current period, for the admin key list: the stored
 * count plus this process's unflushed tally (other replicas' tallies are at
 * most FLUSH_MS behind).
 */
export async function currentUsage(keys: QuotaKey[], at: Date = new Date()): Promise<Map<string, { period: QuotaPeriod; requests: number; resetAt: Date }>> {
  const slots = keys.map((key) => {
    const period: QuotaPeriod = key.quotaPeriod === 'day' ? 'day' : 'month';
    const { start, end } = periodBounds(period, at);
    return { key, period, start, end };
  });
  const rows = slots.length
    ? await prisma.apiKeyUsage.findMany({
        where: { OR: slots.map((s) => ({ apiKeyId: s.key.id, periodStart: s.start })) },
        select: { apiKeyId: true, periodStart: true, requests: true },
      })
    : [];
  const byslot = new Map(rows.map((r) => [slot(r.apiKeyId, r.periodStart), r.requests]));
  return new Map(
    slots.map((s) => {
      const k = slot(s.key.id, s.start);
      return [s.key.id, { period: s.period, requests: (byslot.get(k) ?? 0) + (tallies.get(k)?.n ?? 0), resetAt: s.end }];
    }),
  );
}
