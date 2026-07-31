/**
 * Resolving the caller's IP from a possibly-hostile X-Forwarded-For (#858).
 *
 * Its own module rather than part of rateLimit.ts so the audit logger can use
 * it too (#881) without an import cycle — rateLimit imports logActivity to
 * record breaches, and logActivity needs the IP.
 */
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
/**
 * Anything that can hand us request headers. `Request` satisfies it, and so
 * does the header bag NextAuth passes to `authorize()`, which is a plain object
 * rather than a WHATWG Request.
 */
export interface HeaderSource {
  headers: { get(name: string): string | null };
}

/** Adapt NextAuth's plain header object (or any record) to a `HeaderSource`. */
export function headerSource(headers?: Record<string, string | undefined>): HeaderSource {
  const lower = new Map(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (name) => lower.get(name.toLowerCase()) ?? null } };
}

export function clientIp(request: HeaderSource): string {
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
