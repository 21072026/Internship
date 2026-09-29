/**
 * Resolving the caller's IP from possibly-hostile proxy headers (#858, #2470).
 *
 * Its own module rather than part of rateLimit.ts so the audit logger can use
 * it too (#881) without an import cycle — rateLimit imports logActivity to
 * record breaches, and logActivity needs the IP.
 */

/**
 * How many reverse proxies in front of this app append to `X-Forwarded-For`.
 *
 * Our reverse proxy *appends* the peer address to whatever the client sent
 * (nginx's `$proxy_add_x_forwarded_for`). So the header reads
 * `<whatever the client made up>, <the address the proxy actually saw>` and
 * only the rightmost entries are trustworthy — one per proxy hop.
 *
 * 1 (the default) = a single proxy in front, our current topology. Put another
 * proxy in the path (a Cloudflare orange-cloud record, a load balancer) and
 * this has to grow to match, or every request looks like it comes from that
 * proxy and one visitor's rate limit throttles everyone.
 *
 * 0 = no proxy: nothing in front of the app writes ANY of these headers, so
 * whatever they say was written by the client. Neither `X-Forwarded-For` nor
 * `X-Real-IP` is read and every caller is `'unknown'` (#2470) — one shared
 * bucket per limit, which is strict but cannot be bought out of. An honest
 * client sends neither header and lands there either way; the only caller this
 * setting takes anything from is one that was choosing its own bucket.
 *
 * A value that does not parse as a number reads as 0: an unreadable setting
 * fails closed, towards trusting nothing.
 */
export function parseTrustedProxyCount(raw: string | undefined): number {
  return Math.max(0, parseInt(raw || '1', 10) || 0);
}

const TRUSTED_PROXY_COUNT = parseTrustedProxyCount(process.env.TRUSTED_PROXY_COUNT);

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

/**
 * `clientIp()` with the hop count passed in rather than read from the
 * environment, so the rule can be pinned for every setting in one process
 * (scripts/test/client-ip.test.mjs).
 *
 * `X-Forwarded-For` and `X-Real-IP` sit behind ONE trust gate. Both are
 * proxy-written headers, and with no proxy in front a client writes both:
 * gating only the first (#858) left the second as the same bypass one header
 * over (#2470).
 */
export function clientIpFrom(request: HeaderSource, trustedProxyCount: number): string {
  if (!(trustedProxyCount > 0)) return 'unknown';

  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    // Count back from the right, one entry per trusted hop. A list shorter
    // than expected means the request did not traverse the proxy chain we
    // think it did — fall back to the rightmost (nearest, least
    // client-controlled) entry rather than reaching into client-written text.
    const candidate = parts[Math.max(0, parts.length - trustedProxyCount)];
    const ip = candidate ? validIp(candidate) : null;
    if (ip) return ip;
  }
  // Only reached with a proxy in front and no usable forwarded list; nginx sets
  // this one from `$remote_addr`, overwriting whatever the client sent.
  return validIp(request.headers.get('x-real-ip') || '') || 'unknown';
}

/**
 * The caller's IP, as far as it can be trusted.
 *
 * This used to return `xff.split(',')[0]` — the *leftmost* entry, which is
 * whatever the client put there. Rotating it per request bypassed every
 * IP-based limit in the app: measured on `/api/auth/forgot` (5 per 15 min),
 * 12 spoofed requests all returned 200 where the honest control got 7× 429
 * (#858). It also opened an unbounded key in `buckets` per fabricated value.
 * `X-Real-IP` then stayed trusted at `TRUSTED_PROXY_COUNT=0`, the same hole
 * through the other header (#2470).
 */
export function clientIp(request: HeaderSource): string {
  return clientIpFrom(request, TRUSTED_PROXY_COUNT);
}
