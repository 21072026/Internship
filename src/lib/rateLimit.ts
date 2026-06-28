import { NextResponse } from 'next/server';

// Simple in-memory fixed-window rate limiter. Per-process (fine for a single
// container); resets on redeploy. Not distributed — for stronger guarantees
// move to Redis. Keyed by client IP + a bucket name.
interface Entry {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Entry>();

export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
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

// Occasionally drop expired buckets so the map can't grow unbounded.
export function sweepRateLimitBuckets(now = Date.now()) {
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}
