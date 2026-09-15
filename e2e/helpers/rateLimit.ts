/**
 * Synthetic client addresses, so one spec's rate-limit bucket is its own (#2159).
 *
 * `enforceRateLimit` keys on `bucket:ip`, the counter store is per PROCESS, and
 * a shard runs its whole file list against ONE Next server (`workers: 1`, one
 * `webServer`). Every request that arrives without a usable address therefore
 * counts into the same `<bucket>:unknown` counter — so a spec that deliberately
 * exhausts a bucket exhausts it for every later spec touching that endpoint, for
 * the rest of the shard (the windows here are 15 minutes). That is what turned
 * `e2e-full` shard 4/4 permanently red: `rate-limit.spec.ts`'s six POSTs to
 * `/api/support` (limit 5) left `support-attachments.spec.ts` and
 * `support-chat.spec.ts` with nothing to spend.
 *
 * The webServer runs with `TRUSTED_PROXY_COUNT=0` (playwright.config.ts) so that
 * the #858 spec can prove a rotating `X-Forwarded-For` buys nothing. That is
 * exactly why the isolation goes through `x-real-ip`: `clientIp()` ignores the
 * forwarded header outright under that setting and falls through to this one.
 *
 * Two shapes, and the difference is the whole point:
 *
 * - `floodIp(label)` — a STABLE address. For a test that is measuring the brake
 *   and must therefore spend one counter repeatedly. Its own address, so the
 *   measurement is not perturbed by, and does not perturb, anybody else.
 * - `freshIp(label)` — a NEW address per call. For a spec that merely has to
 *   drive a rate-limited endpoint to get at the feature behind it. It opts out
 *   of the brake rather than budgeting around it: `support-chat.spec.ts` alone
 *   posts seven support messages against a limit of five, so "give the spec one
 *   address" would not have been enough — and a per-spec budget that a later
 *   test silently overspends is the bug this file exists to end.
 *
 * The brake itself is never left untested by this: `rate-limit.spec.ts` asserts
 * it, on addresses nobody else touches.
 */

// Spec-private space (RFC 1918), split so a flood and a fresh address can never
// collide: 10.66.x.y for the floods, 10.77.x.y for the throwaways.
const FLOOD_PREFIX = '10.66';
const FRESH_PREFIX = '10.77';

// .1–.254 in the last octet: no network/broadcast-looking addresses, purely so
// the values read as plausible in an activity log.
function address(prefix: string, index: number): string {
  return `${prefix}.${Math.floor(index / 254) % 254}.${(index % 254) + 1}`;
}

const floods = new Map<string, string>();
let freshCount = 0;

/** Headers pinning a caller to one address, so repeated requests share a bucket. */
export function floodIp(label: string): Record<string, string> {
  let ip = floods.get(label);
  if (!ip) {
    ip = address(FLOOD_PREFIX, floods.size);
    floods.set(label, ip);
  }
  return { 'X-Real-IP': ip, 'X-E2E-Caller': label };
}

/** Headers with an address no other request in this run spends. */
export function freshIp(label: string): Record<string, string> {
  return { 'X-Real-IP': address(FRESH_PREFIX, freshCount++), 'X-E2E-Caller': label };
}
