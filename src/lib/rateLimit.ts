import { NextResponse } from 'next/server';
import { logActivity } from '@/lib/activity';
import { clientIp } from '@/lib/clientIp';

// Re-exported for the several call sites that have always imported it from
// here; the implementation moved to its own module so activity.ts can use it
// without a cycle (rateLimit → activity → rateLimit).
export { clientIp };

// Simple fixed-window rate limiter. Keyed by client IP + a bucket name.
//
// The counters live behind a pluggable store (#1541) rather than directly in a
// Map. `rateLimit()` keeps its synchronous signature — all ~28 call sites are
// untouched — while the *where* becomes swappable: a shared store (Redis, when
// there is ever more than one replica to share between) drops in through
// `setRateLimitStore()` without another sweep through the call sites. Until
// then the default store is the same per-process Map it always was: fine for a
// single container, resets on redeploy, not distributed.
//
// Deliberately NOT the durable brute-force lockout: that one must survive a
// redeploy and be visible to an admin, so it lives in MySQL — see
// `src/lib/accountLockout.ts`. This is the cheap in-front-of-everything brake.
export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * A counter store. Synchronous on purpose — `rateLimit()` is called from
 * synchronous route guards, and an async store would ripple through every
 * caller. A network-backed implementation therefore reads through a local
 * cache and writes behind it, rather than awaiting each hit.
 */
export interface RateLimitStore {
  get(key: string): RateLimitEntry | undefined;
  set(key: string, entry: RateLimitEntry): void;
  delete(key: string): void;
  size(): number;
  /** Drop entries whose window closed at or before `now`. */
  sweep(now: number): void;
}

export function createMemoryRateLimitStore(): RateLimitStore {
  const map = new Map<string, RateLimitEntry>();
  return {
    get: (key) => map.get(key),
    set: (key, entry) => void map.set(key, entry),
    delete: (key) => void map.delete(key),
    size: () => map.size,
    sweep: (now) => {
      for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
    },
  };
}

let store: RateLimitStore = createMemoryRateLimitStore();

/** Swap the counter store (tests, or a future shared implementation). */
export function setRateLimitStore(next: RateLimitStore): void {
  store = next;
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
  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  entry.count += 1;
  // Written back explicitly: the memory store hands out the live object, but a
  // store that returns a copy (any out-of-process one) would otherwise lose it.
  store.set(key, entry);
  if (entry.count > limit) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
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
// IP has exceeded `limit` requests to `bucket` within `windowMs`, else null.
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
  // amplifier for the attack it is supposed to absorb.
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
// count toward the brute-force limit).
export function clearRateLimit(key: string) {
  store.delete(key);
}

// Occasionally drop expired buckets so the map can't grow unbounded.
export function sweepRateLimitBuckets(now = Date.now()) {
  store.sweep(now);
}
