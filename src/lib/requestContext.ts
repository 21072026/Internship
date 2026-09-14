// Request-scoped correlation context (#1601).
//
// THE PROBLEM IT SOLVES
//   "A mentor says saving failed around 14:20" is only answerable if one line in
//   the container log can be tied to one request. `src/middleware.ts` mints the
//   id and echoes it as `x-request-id`, so the user (or a proxy log, or a
//   support screenshot of the network tab) can name it; this module is what
//   carries that same id into every `logger.*` line emitted while the request is
//   handled, without a single caller passing it along by hand.
//
// THE MECHANISM
//   An `AsyncLocalStorage`, modelled exactly on `src/lib/orgContext.ts` — the
//   repo already had this pattern for the tenant id and does not need a second
//   one. Middleware's async context does NOT wrap the route handler (it is a
//   separate invocation, on a different runtime), so the id travels as a request
//   header and the context is re-established inside the handler by
//   `withRequestScope(request, fn)`.
//
// SERVER-ONLY
//   It imports `node:async_hooks`, which webpack refuses to bundle for a client
//   graph ("Reading from node:async_hooks is not handled by plugins") — the same
//   constraint documented in `src/lib/prisma.ts` and `src/lib/tenantAmbient.ts`.
//   Never import this from a `'use client'` component. Anything client-reachable
//   that wants the id reads `ambientRequestId()` from `src/lib/requestId.ts`,
//   which imports nothing; loading this file is what fills that seam.

import { AsyncLocalStorage } from 'node:async_hooks';
import { REQUEST_ID_HEADER, registerRequestIdAmbient, resolveRequestId } from './requestId';

const storage = new AsyncLocalStorage<{ requestId: string }>();

/**
 * The id of the request being handled, or `undefined` when no context is bound
 * — a cron tick, a deploy script, a module evaluated at boot. `undefined` is not
 * an error: the logger omits the field rather than inventing an id that
 * correlates with nothing.
 */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Run `fn` with `requestId` bound as the current request's id.
 *
 * Nesting is a no-op by design: an already-bound id wins, so a handler that
 * calls a helper which also wraps cannot end up with two ids for one request
 * (and therefore two halves of one story in the log).
 */
export function withRequestContext<T>(requestId: string, fn: () => T): T {
  const existing = currentRequestId();
  if (existing) return fn();
  return storage.run({ requestId }, fn);
}

/**
 * Bind the request context from the incoming request — the wrapper a route
 * handler uses.
 *
 * Reads the `x-request-id` middleware forwarded (see `src/middleware.ts`), falls
 * back to minting one when the handler is reached without passing through
 * middleware (a direct server-side call, a test), and validates either way:
 * `resolveRequestId` refuses anything that is not the bounded, log-safe
 * alphabet, so nothing a caller sent can forge a log line.
 *
 * Only the header is read. Deliberately no method, path, query string or body —
 * this is a correlation id, not a request dump, and a query string here carries
 * candidate names and e-mail addresses (docs/DATA_ACCESS_POLICY.md).
 */
export function withRequestScope<T>(request: Request | Headers, fn: () => T): T {
  const headers = request instanceof Headers ? request : request.headers;
  return withRequestContext(resolveRequestId(headers.get(REQUEST_ID_HEADER)), fn);
}

// Publish the engine to the client-safe seam so `src/lib/logger.ts` — imported
// by modules that must not pull in `node:async_hooks` — can read the bound id.
// Evaluating this module is what registers it, and any request that binds a
// context has evaluated it, because `withRequestScope` above lives here.
registerRequestIdAmbient({ currentRequestId });
