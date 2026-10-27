// The error tracker's one sender (#1600). Every server-side capture — the
// `onRequestError` hook in `src/instrumentation.ts`, the job worker's failure
// hook and the browser relay `/api/telemetry/errors` — ends in
// `captureError()` here; nothing else may POST to the tracker.
//
// OFF UNLESS `ERROR_TRACKING_DSN` PARSES. With no DSN this module does nothing
// at all: no fetch, no timer, no console line (the e2e suite and every topic
// environment run that way). The rules — what an event may carry, how it is
// masked — are in `errorTrackingRule.ts`; this file only stamps the release and
// the ambient ids and sends.
//
// EDGE-SAFE ON PURPOSE. It is imported by `src/instrumentation.ts`, which Next
// also compiles for the edge runtime, so it may depend on `fetch` and the
// dependency-free seams only (`requestId.ts`, `tenantAmbient.ts`) — never on
// Prisma, `node:*` or the server-only request context engine.
//
// Fire and forget: a capture never throws, never awaits the network on the
// caller's path unless the caller awaits the returned promise, and gives up
// after SEND_TIMEOUT_MS. A tracker outage costs us events, never a request.

import { APP_VERSION, GIT_SHA } from './version';
import { APP_ENV } from './appEnv';
import { ambientRequestId } from './requestId';
import { ambientOrgId } from './tenantAmbient';
import {
  EventThrottle,
  authHeader,
  buildEvent,
  envelopeBody,
  newEventId,
  parseDsn,
  throttleKey,
  type ErrorInput,
  type ParsedDsn,
} from './errorTrackingRule';

const SEND_TIMEOUT_MS = 3000;

let cached: { raw: string | undefined; dsn: ParsedDsn | null } | null = null;
function dsn(): ParsedDsn | null {
  const raw = process.env.ERROR_TRACKING_DSN;
  if (!cached || cached.raw !== raw) cached = { raw, dsn: parseDsn(raw) };
  return cached.dsn;
}

/** Whether a DSN is configured — the browser relay answers 204 without one. */
export function errorTrackingEnabled(): boolean {
  return dsn() !== null;
}

const throttle = new EventThrottle();
let warnedSendFailure = false;

/**
 * Report one error. Resolves to the event id when an event was sent, `null`
 * when the tracker is off, throttled or unreachable. Never rejects.
 */
export async function captureError(input: ErrorInput): Promise<string | null> {
  const target = dsn();
  if (!target) return null;
  try {
    const tags = { ...input.tags };
    if (!tags.requestId) tags.requestId = ambientRequestId();
    if (!tags.orgId) tags.orgId = ambientOrgId() ?? undefined;
    const now = new Date();
    const event = buildEvent(
      { ...input, tags },
      { release: GIT_SHA, version: APP_VERSION, environment: process.env.ERROR_TRACKING_ENVIRONMENT || APP_ENV },
      newEventId(),
      now,
    );
    if (!throttle.allow(throttleKey(event), now.getTime())) return null;
    const res = await fetch(target.envelopeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': authHeader(target) },
      body: envelopeBody(event, now),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`tracker answered ${res.status}`);
    return event.event_id;
  } catch (e) {
    // Once per process: a misconfigured DSN should be visible in the log, but
    // a tracker outage must not double every error line.
    if (!warnedSendFailure) {
      warnedSendFailure = true;
      console.warn('[error-tracking] send failed', e instanceof Error ? e.message : String(e));
    }
    return null;
  }
}
