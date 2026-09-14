// The request-correlation id: its header name, its grammar, and the
// client-safe seam onto the server-only context that carries it (#1601).
//
// WHY THIS FILE HAS NO IMPORTS
//   Three very different runtimes need these functions:
//     - `src/middleware.ts` runs on the **edge** runtime (no `node:crypto`, no
//       `next/headers`, no Prisma — see the header there), and it is where the
//       id is minted.
//     - `src/lib/logger.ts` is imported by ~25 server modules and must stay
//       cheap and bundler-agnostic; it reads the id through `ambientRequestId()`
//       below rather than importing the AsyncLocalStorage engine.
//     - `scripts/test/request-id.test.mjs` unit-tests the grammar with no
//       framework at all.
//   So this module imports nothing. The engine that actually stores a value per
//   request lives in `src/lib/requestContext.ts`, which is SERVER-ONLY
//   (`node:async_hooks`) and registers itself here when it is loaded — exactly
//   the seam `src/lib/tenantAmbient.ts` is for `orgContext.ts` (#1553).

// One spelling, everywhere. Lowercase because that is how both `Headers.get()`
// and every proxy normalise it.
export const REQUEST_ID_HEADER = 'x-request-id';

// A minted id is a UUID (36 chars). The cap is generous enough for the ids other
// systems hand us — a whole W3C `traceparent` is 55 characters — and small
// enough that no log line can be padded out with someone else's payload.
export const MAX_REQUEST_ID_LENGTH = 128;

// Hex, dashes, underscores, dots and colons: the alphabet tracing systems
// actually use, and deliberately nothing else. No whitespace (a newline would
// forge a second log line), no quotes or braces (they would break the JSON
// payload a log search greps), no control characters.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * Is this string safe to print into a log line and echo in a header?
 *
 * An inbound `x-request-id` is attacker-controlled — it is a header on a public
 * request. Honouring it is worth something (a load balancer or the k6 runner may
 * already have an id for this request), but it is never trusted as-is.
 */
export function isValidRequestId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH && REQUEST_ID_PATTERN.test(value);
}

/**
 * Mint a fresh id. `crypto.randomUUID()` exists on the edge runtime, in Node and
 * in the browser; the fallback is only for an exotic host without it, and
 * uniqueness per request is all that is asked of it (this id authorises
 * nothing).
 */
export function newRequestId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The id for this request: the inbound one when it is well-formed, otherwise a
 * fresh one.
 *
 * A malformed inbound value is **replaced, not repaired**. Truncating a 4 KB id
 * or stripping characters out of it yields something that correlates with
 * nothing while still looking like the caller's id — worse than a clean new one.
 */
export function resolveRequestId(inbound: string | null | undefined): string {
  const candidate = (inbound || '').trim();
  return isValidRequestId(candidate) ? candidate : newRequestId();
}

// ── The client-safe seam onto the request context ────────────────────────────

export type RequestIdAmbient = {
  // The id bound to the current async context, or undefined when none is.
  currentRequestId: () => string | undefined;
};

let ambient: RequestIdAmbient | null = null;

// Called once by src/lib/requestContext.ts when that module is evaluated.
export function registerRequestIdAmbient(impl: RequestIdAmbient): void {
  ambient = impl;
}

/**
 * The id of the request being handled, or `undefined` outside a request — a
 * cron tick, a deploy backfill, or a process where the server-only engine was
 * never loaded. `undefined` is the honest answer there, and the logger simply
 * omits the field.
 */
export function ambientRequestId(): string | undefined {
  return ambient?.currentRequestId();
}
