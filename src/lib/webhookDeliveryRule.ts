// Webhook delivery rules (#1695) — pure, dependency-free, unit-tested in
// e2e/webhook-delivery.unit.spec.ts. The Prisma half is ./webhookDelivery.ts.
//
// THE MODEL
//   A public domain event fans out to ONE queue job per (event × subscription)
//   (`webhook.deliver`), so a hanging receiver holds only its own job — never
//   another partner's delivery of the same event (the old `Promise.all`).
//   Every attempt of that job writes one `WebhookDelivery` row; the queue's
//   own backoff (src/lib/jobs/workerRule.ts) spaces the retries.
//
//   • 2xx                      → SUCCESS
//   • 5xx, 408, 429, a timeout
//     or a network error       → FAILED and the job retries; the last attempt is DEAD
//   • any other status (4xx,
//     a redirect) or a URL the
//     SSRF guard refuses       → DEAD at once: a retry would get the same answer
//
//   Delivery is AT-LEAST-ONCE: a container killed after the POST but before
//   the row settled sends it again, and an admin may replay it. Every attempt
//   carries the same `X-Delivery-Id`, so a receiver dedupes on that header.
//
// AUTO-DISABLE
//   A failure streak is counted on the hook (`consecutiveFailures`,
//   `failingSince`) and reset by any 2xx. At WEBHOOK_DISABLE_AFTER_FAILURES
//   failures, or a streak older than WEBHOOK_DISABLE_AFTER_MS, the hook is
//   disabled ONCE — the transition, not every later attempt, mails the admins
//   — and the relay skips it until an admin re-enables it. A dead endpoint
//   retried for a month is how a receiver rate-limits the whole sending host.

import { createHash } from 'node:crypto';

/** Attempts per (event × subscription): ~1 h of backoff from 30 s (DEFAULT_BACKOFF). */
export const WEBHOOK_MAX_ATTEMPTS = 8;
/** Stored response bodies are cut here. */
export const WEBHOOK_RESPONSE_BODY_LIMIT = 2_000;
/** Stored error texts are cut here. */
export const WEBHOOK_ERROR_LIMIT = 1_000;
export const WEBHOOK_DISABLE_AFTER_FAILURES = 20;
export const WEBHOOK_DISABLE_AFTER_MS = 72 * 60 * 60 * 1000;
/** "Replay the last N events" accepts at most this many. */
export const WEBHOOK_REPLAY_MAX = 50;

export type WebhookDeliveryStatusName = 'PENDING' | 'SUCCESS' | 'FAILED' | 'DEAD';

export type AttemptResult =
  | { kind: 'response'; status: number; body: string; ms: number }
  | { kind: 'error'; error: string; ms: number; refused?: boolean };

export type AttemptClass = 'success' | 'retryable' | 'permanent';

/**
 * The stable `X-Delivery-Id` of one (event × subscription): identical on every
 * attempt and every replay. Opaque — it reveals neither id.
 */
export function webhookDeliveryId(eventId: string, webhookId: string): string {
  return `whd_${createHash('sha256').update(`${eventId}:${webhookId}`).digest('hex').slice(0, 40)}`;
}

/** `Job.idempotencyKey` of the fan-out: a rerun of the subscriber enqueues nothing twice. */
export function webhookJobKey(eventId: string, webhookId: string): string {
  return `whk:${eventId}:${webhookId}`;
}

export function classifyAttempt(result: AttemptResult): AttemptClass {
  if (result.kind === 'error') return result.refused ? 'permanent' : 'retryable';
  const s = result.status;
  if (s >= 200 && s < 300) return 'success';
  // A receiver that is overloaded or timed the request out may well take it
  // later; every other 4xx (and a redirect, which is never followed — it would
  // walk around the SSRF check) will answer the same way next time.
  if (s >= 500 || s === 408 || s === 429) return 'retryable';
  return 'permanent';
}

/** What this attempt's row settles as. `attempt` is 1-based. */
export function attemptStatus(cls: AttemptClass, attempt: number, maxAttempts: number): Exclude<WebhookDeliveryStatusName, 'PENDING'> {
  if (cls === 'success') return 'SUCCESS';
  if (cls === 'permanent') return 'DEAD';
  return attempt >= Math.max(1, maxAttempts) ? 'DEAD' : 'FAILED';
}

/** Cut a stored text to `limit` characters, marking the cut. */
export function truncateText(text: string | null | undefined, limit: number): string | null {
  if (text == null) return null;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated, ${text.length} chars]`;
}

export interface HookHealth {
  consecutiveFailures: number;
  failingSince: Date | null;
  lastSuccessAt: Date | null;
}

export interface HealthUpdate extends HookHealth {
  /** Set when THIS attempt crosses the threshold; the writer stamps it only on a still-enabled hook. */
  disableReason: string | null;
}

/** The hook's health after one finished attempt. */
export function nextHealth(current: HookHealth, cls: AttemptClass, now: Date): HealthUpdate {
  if (cls === 'success') return { consecutiveFailures: 0, failingSince: null, lastSuccessAt: now, disableReason: null };
  const consecutiveFailures = current.consecutiveFailures + 1;
  const failingSince = current.failingSince ?? now;
  let disableReason: string | null = null;
  if (consecutiveFailures >= WEBHOOK_DISABLE_AFTER_FAILURES) {
    disableReason = `${consecutiveFailures} consecutive failed deliveries`;
  } else if (now.getTime() - failingSince.getTime() >= WEBHOOK_DISABLE_AFTER_MS) {
    disableReason = `no successful delivery for ${Math.floor(WEBHOOK_DISABLE_AFTER_MS / 3_600_000)} hours`;
  }
  return { consecutiveFailures, failingSince, lastSuccessAt: current.lastSuccessAt, disableReason };
}

/** Clamp a "replay the last N events" request. */
export function clampReplayCount(n: unknown): number | null {
  const v = typeof n === 'number' ? n : typeof n === 'string' && n.trim() !== '' ? Number(n) : NaN;
  if (!Number.isInteger(v) || v < 1) return null;
  return Math.min(v, WEBHOOK_REPLAY_MAX);
}

// ── The attempt itself, with its storage behind a seam ─────────────────────

export interface DeliveryHook {
  id: string;
  orgId: string | null;
  url: string;
  secret: string;
  consecutiveFailures: number;
  failingSince: Date | null;
  lastSuccessAt: Date | null;
}

export interface DeliveryEvent {
  id: string;
  name: string;
  orgId: string | null;
  /** Already re-parsed through the catalogue, in the producer's key order. */
  payload: Record<string, unknown>;
}

export interface DeliveryDeps {
  /** The hook, only if it is still a live, enabled subscription of the event's tenant. */
  loadLiveHook(webhookId: string, orgId: string | null): Promise<DeliveryHook | null>;
  loadEvent(eventId: string): Promise<DeliveryEvent | null>;
  insertAttempt(row: {
    orgId: string | null;
    webhookId: string;
    eventId: string;
    eventName: string;
    deliveryId: string;
    attempt: number;
  }): Promise<{ id: string }>;
  finishAttempt(
    id: string,
    patch: { status: WebhookDeliveryStatusName; responseCode: number | null; responseBody: string | null; error: string | null; durationMs: number },
  ): Promise<void>;
  /** Write the hook's new health. Resolves true when THIS write disabled it (the guarded transition). */
  saveHealth(webhookId: string, health: HealthUpdate, now: Date): Promise<boolean>;
  post(hook: DeliveryHook, event: DeliveryEvent, deliveryId: string): Promise<AttemptResult>;
  notifyDisabled(hook: DeliveryHook, reason: string): Promise<void>;
  now(): Date;
}

export type DeliveryOutcomeName = WebhookDeliveryStatusName | 'skipped_hook' | 'missing_event';

export class RetryableDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableDeliveryError';
  }
}

/**
 * One attempt of one (event × subscription). Resolves with the row's status;
 * THROWS `RetryableDeliveryError` on a FAILED attempt so the queue schedules
 * the next one with its backoff. A DEAD attempt resolves — the job is done,
 * and the failure lives on the delivery row rather than in the dead-letter queue.
 */
export async function runDeliveryAttempt(
  deps: DeliveryDeps,
  job: { eventId: string; webhookId: string },
  attempt: number,
  maxAttempts: number,
): Promise<DeliveryOutcomeName> {
  const event = await deps.loadEvent(job.eventId);
  if (!event) return 'missing_event';
  // A hook deleted, paused, auto-disabled, moved to another tenant or whose
  // owner key was revoked since the fan-out gets nothing — and no row.
  const hook = await deps.loadLiveHook(job.webhookId, event.orgId);
  if (!hook) return 'skipped_hook';

  const deliveryId = webhookDeliveryId(event.id, hook.id);
  const row = await deps.insertAttempt({
    orgId: hook.orgId,
    webhookId: hook.id,
    eventId: event.id,
    eventName: event.name,
    deliveryId,
    attempt,
  });

  let result: AttemptResult;
  try {
    result = await deps.post(hook, event, deliveryId);
  } catch (e) {
    result = { kind: 'error', error: String(e), ms: 0 };
  }
  const cls = classifyAttempt(result);
  const status = attemptStatus(cls, attempt, maxAttempts);
  await deps.finishAttempt(row.id, {
    status,
    responseCode: result.kind === 'response' ? result.status : null,
    responseBody: result.kind === 'response' ? truncateText(result.body, WEBHOOK_RESPONSE_BODY_LIMIT) : null,
    error: result.kind === 'error' ? truncateText(result.error, WEBHOOK_ERROR_LIMIT) : null,
    durationMs: Math.max(0, Math.round(result.ms)),
  });

  const now = deps.now();
  const health = nextHealth(hook, cls, now);
  const disabledNow = await deps.saveHealth(hook.id, health, now);
  if (disabledNow && health.disableReason) await deps.notifyDisabled(hook, health.disableReason);

  // A hook disabled by this very attempt is not retried: the relay skips it.
  if (status === 'FAILED' && !disabledNow) {
    throw new RetryableDeliveryError(
      result.kind === 'response' ? `receiver answered ${result.status}` : `delivery failed: ${truncateText(result.error, 200)}`,
    );
  }
  return status;
}
