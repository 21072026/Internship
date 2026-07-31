import { NextResponse } from 'next/server';

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

// Returns { ok } or { ok:false, retryAfter } when the limit is exceeded.
export function rateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number }
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
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

// Convenience guard for route handlers: returns a 429 NextResponse when the
// IP has exceeded `limit` requests to `bucket` within `windowMs`, else null.
export function enforceRateLimit(
  request: Request,
  bucket: string,
  opts: { limit: number; windowMs: number }
): NextResponse | null {
  const res = rateLimit(`${bucket}:${clientIp(request)}`, opts);
  if (res.ok) return null;
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
