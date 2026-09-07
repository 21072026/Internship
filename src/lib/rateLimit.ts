import { NextResponse } from 'next/server';
import { logActivity } from '@/lib/activity';
import { clientIp } from '@/lib/clientIp';
import { logger } from '@/lib/logger';
import {
  countRequest,
  createMemoryRateLimitStore,
  selectRateLimitStore,
  setRateLimitStoreLogger,
  type RateLimitEntry,
  type RateLimitStore,
  type RateLimitStoreStatus,
} from '@/lib/rateLimitStore';

// Re-exported for the several call sites that have always imported it from
// here; the implementation moved to its own module so activity.ts can use it
// without a cycle (rateLimit → activity → rateLimit).
export { clientIp };

// The counter store and its types live in `rateLimitStore.ts` (#1696); they are
// re-exported here because that is where they used to be defined.
export { createMemoryRateLimitStore };
export type { RateLimitEntry, RateLimitStore, RateLimitStoreStatus };

// Simple fixed-window rate limiter. Keyed by client IP + a bucket name.
//
// The counters live behind a pluggable store (#1541) rather than directly in a
// Map. `rateLimit()` keeps its synchronous signature — all ~28 call sites are
// untouched — while the *where* is chosen by configuration (#1696): set
// `RATE_LIMIT_REDIS_URL` and every replica counts into one shared counter;
// leave it unset and the store is the same per-process Map it always was — fine
// for a single container, resets on redeploy, not distributed.
//
// The shared store FAILS OPEN: if it is unreachable the limiter falls back to
// the in-process mirror and says so in the log and on /api/health, rather than
// erroring a request or locking anyone out of sign-in. See rateLimitStore.ts
// for the reasoning and for the bounded overshoot that buys.
//
// Deliberately NOT the durable brute-force lockout: that one must survive a
// redeploy and be visible to an admin, so it lives in MySQL — see
// `src/lib/accountLockout.ts`. This is the cheap in-front-of-everything brake.

// The store module has no imports of its own (so it stays unit-testable with
// `node --test`); the app's logger is handed to it here, before the first store
// is built, so a degradation is reported through the same structured log as
// everything else.
setRateLimitStoreLogger(logger);

let store: RateLimitStore = selectRateLimitStore().store;

/** Swap the counter store (tests; the backend itself comes from config). */
export function setRateLimitStore(next: RateLimitStore): void {
  store = next;
}

/**
 * Which backend the limiter is counting into, and whether it is degraded.
 * Surfaced by /api/health so a silently per-process limiter is visible to an
 * operator instead of being discovered during an incident.
 */
export function rateLimitStoreHealth(): RateLimitStoreStatus {
  return (
    store.status?.() ?? { backend: 'memory', degraded: false, degradedSince: null, lastError: null }
  );
}

// Bucket housekeeping (#864). `sweepRateLimitBuckets` existed but nothing ever
// called it, so expired entries accumulated for the life of the process. Sweep
// every SWEEP_EVERY calls rather than on a timer — no scheduler to own, and the
// work is proportional to traffic, which is when it is needed.
const SWEEP_EVERY = 100;
// Hard ceiling as a backstop: if a flood outruns the periodic sweep, drop the
// expired entries immediately rather than letting the map grow without bound.
const MAX_BUCKETS = 50_000;
let callsSinceSweep = 0;

function housekeep(now: number) {
  if (++callsSinceSweep >= SWEEP_EVERY || store.size() > MAX_BUCKETS) {
    callsSinceSweep = 0;
    sweepRateLimitBuckets(now);
  }
}

// Returns { ok } or { ok:false, retryAfter } when the limit is exceeded.
export function rateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number }
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  housekeep(now);
  return countRequest(store, key, { limit, windowMs }, now);
}

const BREACH_LOG_EVERY_MS = 60_000;
const breachLoggedAt = new Map<string, number>();

function shouldLogBreach(key: string): boolean {
  const now = Date.now();
  const last = breachLoggedAt.get(key);
  if (last && now - last < BREACH_LOG_EVERY_MS) return false;
  breachLoggedAt.set(key, now);
  // Piggyback on the same ceiling as the counters: this map is keyed the same
  // way, so a flood of unique keys would otherwise grow it just as fast.
  if (breachLoggedAt.size > MAX_BUCKETS) {
    for (const [k, t] of breachLoggedAt) if (now - t >= BREACH_LOG_EVERY_MS) breachLoggedAt.delete(k);
  }
  return true;
}

// Convenience guard for route handlers: returns a 429 NextResponse when the
// subject (or client IP by default) has exceeded `limit` requests to `bucket` within `windowMs`, else null.
export function enforceRateLimit(
  request: Request,
  bucket: string,
  opts: { limit: number; windowMs: number; subject?: string }
): NextResponse | null {
  const identity = opts.subject ?? clientIp(request);
  const key = `${bucket}:${identity}`;
  const res = rateLimit(key, opts);
  if (res.ok) return null;
  // Breaches were recorded nowhere, so being under attack looked exactly like
  // being idle (#864). Fire-and-forget keeps this function synchronous — its
  // callers stay untouched — and logActivity never throws by design.
  //
  // Coalesced to one row per key per minute: a flood is exactly when this fires,
  // and a DB insert per blocked request would turn the rate limiter into an
  // amplifier for the attack it is supposed to absorb. The coalescing window is
  // per-process even with a shared store, which is the safe direction: with N
  // replicas a sustained flood costs at most N rows a minute, never N inserts a
  // request.
  if (shouldLogBreach(key)) {
    void logActivity({
      action: 'ratelimit.exceeded',
      level: 'warning',
      detail: `${bucket} · ${identity}`,
    }).catch(() => {});
  }
  return NextResponse.json(
    { error: 'Too many requests. Please try again later.' },
    { status: 429, headers: { 'Retry-After': String(res.retryAfter) } }
  );
}

// Clear a key's counter (e.g. on a successful login, so good logins never
// count toward the brute-force limit). With a shared store this clears the
// shared counter too, not just this replica's mirror.
export function clearRateLimit(key: string) {
  store.delete(key);
}

// Occasionally drop expired buckets so the map can't grow unbounded.
export function sweepRateLimitBuckets(now = Date.now()) {
  store.sweep(now);
}
