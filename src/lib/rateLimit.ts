import { NextResponse } from 'next/server';
import { logActivity } from '@/lib/activity';

// Simple in-memory fixed-window rate limiter. Per-process (fine for a single
// container); resets on redeploy. Not distributed — for stronger guarantees
// move to Redis. Keyed by client IP + a bucket name.
interface Entry {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Entry>();

/**
 * How many reverse proxies in front of this app append to `X-Forwarded-For`.
 *
 * Our nginx vhost uses `$proxy_add_x_forwarded_for`, which *appends* the peer
 * address to whatever the client sent. So the header reads
 * `<whatever the client made up>, <the address nginx actually saw>` and only
 * the rightmost entries are trustworthy — one per proxy hop.
 *
 * 1 (the default) = a single nginx in front, our current topology. Put another
 * proxy in the path (a Cloudflare orange-cloud record, a load balancer) and
 * this has to grow to match, or every request looks like it comes from that
 * proxy and one visitor's rate limit throttles everyone.
 *
 * 0 = no proxy: ignore the header entirely and trust nothing from it.
 */
const TRUSTED_PROXY_COUNT = Math.max(0, parseInt(process.env.TRUSTED_PROXY_COUNT || '1', 10) || 0);

// Deliberately permissive shape checks rather than full parsers: the value is a
// rate-limit map key, and the only thing that matters is that a client can't
// smuggle arbitrary text into it.
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

function validIp(value: string): string | null {
  const ip = value.trim().replace(/^\[|\]$/g, '');
  if (!ip) return null;
  if (IPV4.test(ip)) return ip.split('.').every((o) => Number(o) <= 255) ? ip : null;
  if (ip.includes(':') && IPV6.test(ip)) return ip.toLowerCase();
  return null;
}

/**
 * The caller's IP, as far as it can be trusted.
 *
 * This used to return `xff.split(',')[0]` — the *leftmost* entry, which is
 * whatever the client put there. Rotating it per request bypassed every
 * IP-based limit in the app: measured on `/api/auth/forgot` (5 per 15 min),
 * 12 spoofed requests all returned 200 where the honest control got 7× 429
 * (#858). It also opened an unbounded key in `buckets` per fabricated value.
 */
export function clientIp(request: Request): string {
  if (TRUSTED_PROXY_COUNT > 0) {
    const xff = request.headers.get('x-forwarded-for');
    if (xff) {
      const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
      // Count back from the right, one entry per trusted hop. A list shorter
      // than expected means the request did not traverse the proxy chain we
      // think it did — fall back to the rightmost (nearest, least
      // client-controlled) entry rather than reaching into client-written text.
      const candidate = parts[Math.max(0, parts.length - TRUSTED_PROXY_COUNT)];
      const ip = candidate ? validIp(candidate) : null;
      if (ip) return ip;
    }
  }
  return validIp(request.headers.get('x-real-ip') || '') || 'unknown';
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
  if (++callsSinceSweep >= SWEEP_EVERY || buckets.size > MAX_BUCKETS) {
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
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  entry.count += 1;
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
  opts: { limit: number; windowMs: number }
): NextResponse | null {
  const ip = clientIp(request);
  const res = rateLimit(`${bucket}:${ip}`, opts);
  if (res.ok) return null;
  // Breaches were recorded nowhere, so being under attack looked exactly like
  // being idle (#864). Fire-and-forget keeps this function synchronous — its
  // six callers stay untouched — and logActivity never throws by design.
  //
  // Coalesced to one row per key per minute: a flood is exactly when this fires,
  // and a DB insert per blocked request would turn the rate limiter into an
  // amplifier for the attack it is supposed to absorb.
  if (shouldLogBreach(`${bucket}:${ip}`)) {
    void logActivity({
      action: 'ratelimit.exceeded',
      level: 'warning',
      detail: `${bucket} · ${ip}`,
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
  buckets.delete(key);
}

// Occasionally drop expired buckets so the map can't grow unbounded.
export function sweepRateLimitBuckets(now = Date.now()) {
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}
