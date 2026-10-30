// Webhook delivery — the Prisma half (#1695). Server-only. The rules are in
// ./webhookDeliveryRule.ts; this file binds them to the database, the queue
// and the mailer, and is the ONLY writer of `WebhookDelivery` rows and of a
// hook's delivery-health columns.
//
//   event.deliver (subscriber 'webhook')  →  fanOutWebhookEvent()
//       one `webhook.deliver` job per live subscription, keyed
//       `whk:<eventId>:<webhookId>` so a rerun of the fan-out enqueues nothing twice
//   webhook.deliver                        →  runWebhookDelivery()
//       one attempt, one row; a FAILED attempt throws and the queue retries
//
// Nothing here runs under a session, so every query names its `orgId` itself
// (the hook's / the event's), never the ambient tenant.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { enqueue } from '@/lib/jobs/queue';
import { logActivity } from '@/lib/activity';
import { validateEventPayload } from '@/lib/events/catalog';
import type { DeliveredEvent } from '@/lib/events/subscribers';
import { SsrfBlockedError, SsrfUnresolvedError } from '@/lib/ssrfGuard';
import { deliverToWebhook, liveSubscriptionsWhere, type WebhookEvent } from '@/lib/webhooks';
import { companyReceiverCheck } from '@/lib/companyWebhookScope';
import { sourceReceiverCheck } from '@/lib/sourceWebhookScope';
import {
  runDeliveryAttempt,
  webhookJobKey,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RESPONSE_BODY_LIMIT,
  type DeliveryDeps,
  type DeliveryOutcomeName,
} from './webhookDeliveryRule';

function subscribesTo(events: Prisma.JsonValue, name: string): boolean {
  return Array.isArray(events) && (events as unknown[]).includes(name);
}

async function enqueueDelivery(eventId: string, webhookId: string, orgId: string | null, replayOf?: string) {
  return enqueue(
    'webhook.deliver',
    { eventId, webhookId },
    {
      orgId,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      // A replay is a new job on purpose — the original key is spent. Its
      // X-Delivery-Id is still the original one, so a receiver that already
      // has the event drops the repeat.
      idempotencyKey: replayOf ? `${webhookJobKey(eventId, webhookId)}:replay:${replayOf}` : webhookJobKey(eventId, webhookId),
      trigger: replayOf ? 'manual' : 'event',
    },
  );
}

/**
 * Both owner checks of one event (#2006), each memoised: a hook with neither
 * `companyId` nor `sourceId` passes untouched; an owned hook receives the
 * event only when its owner's check says so.
 */
function ownerReceiverCheck(event: { name: string; orgId: string | null; payload: Record<string, unknown> }) {
  const company = companyReceiverCheck(event);
  const source = sourceReceiverCheck(event);
  return async (hook: { companyId: string | null; sourceId: string | null }) => (await company(hook)) && (await source(hook));
}

/**
 * The webhook subscriber's body: one delivery job per live subscription of the
 * event's tenant that wants it. Never `Promise.all` across subscriptions — each
 * receiver is its own job, so the slowest one delays nobody else.
 */
export async function fanOutWebhookEvent(event: DeliveredEvent): Promise<number> {
  const hooks = await prisma.webhook.findMany({
    where: liveSubscriptionsWhere(event.orgId),
    select: { id: true, events: true, companyId: true, sourceId: true },
  });
  // A company's own hook only gets its own company's hiring events, a
  // source's own hook only its own candidates' events (#2006).
  const mayReceive = ownerReceiverCheck(event);
  let queued = 0;
  for (const h of hooks) {
    if (!subscribesTo(h.events, event.name)) continue;
    if (!(await mayReceive(h))) continue;
    await enqueueDelivery(event.id, h.id, event.orgId);
    queued += 1;
  }
  return queued;
}

const deps: DeliveryDeps = {
  loadEvent: async (id) => {
    const row = await prisma.domainEvent.findUnique({ where: { id }, select: { id: true, name: true, orgId: true, payload: true, version: true } });
    if (!row) return null;
    // Re-parsed like every subscriber delivery (emitCore.ts § DELIVERY): MySQL
    // re-orders JSON keys, the schema restores the producer's order, so the
    // signed body is byte-identical to the one the producer used to post.
    const parsed = validateEventPayload(row.name, row.payload, row.version);
    return { id: row.id, name: row.name, orgId: row.orgId, payload: parsed.ok ? parsed.payload : (row.payload as Record<string, unknown>) };
  },
  loadLiveHook: (webhookId, orgId) =>
    prisma.webhook.findFirst({
      where: { id: webhookId, ...liveSubscriptionsWhere(orgId) },
      select: { id: true, orgId: true, url: true, secret: true, consecutiveFailures: true, failingSince: true, lastSuccessAt: true },
    }),
  insertAttempt: (row) => prisma.webhookDelivery.create({ data: { ...row, status: 'PENDING' }, select: { id: true } }),
  finishAttempt: async (id, patch) => {
    await prisma.webhookDelivery.update({ where: { id }, data: patch });
  },
  saveHealth: async (webhookId, health, now) => {
    await prisma.webhook.update({
      where: { id: webhookId },
      data: { consecutiveFailures: health.consecutiveFailures, failingSince: health.failingSince, lastSuccessAt: health.lastSuccessAt },
    });
    if (!health.disableReason) return false;
    // The guarded transition: only the attempt that finds the hook still
    // enabled stamps it, so the admins are told once — not once per attempt,
    // and not once per racing job.
    const { count } = await prisma.webhook.updateMany({
      where: { id: webhookId, disabledAt: null },
      data: { disabledAt: now, disabledReason: health.disableReason.slice(0, 191) },
    });
    return count === 1;
  },
  post: async (hook, event, deliveryId) => {
    try {
      const res = await deliverToWebhook(hook, event.name as WebhookEvent, event.payload, {
        deliveryId,
        bodyLimit: WEBHOOK_RESPONSE_BODY_LIMIT + 1,
      });
      return { kind: 'response', status: res.status, body: res.body, ms: res.ms };
    } catch (e) {
      // A private/internal target is refused for good; a host that did not
      // resolve (or a timeout, a reset) may answer next time.
      const refused = e instanceof SsrfBlockedError && !(e instanceof SsrfUnresolvedError);
      const text = e instanceof SsrfBlockedError ? `refused: ${e.message}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { kind: 'error', error: text, ms: 0, refused };
    }
  },
  notifyDisabled: async (hook, reason) => {
    await logActivity({
      action: 'webhook.auto_disabled',
      level: 'warning',
      targetType: 'webhook',
      targetId: hook.id,
      orgId: hook.orgId,
      detail: reason,
    });
    if (!hook.orgId) return;
    const admins = await prisma.user.findMany({
      where: { orgId: hook.orgId, role: 'ADMIN', isActive: true },
      select: { id: true, email: true, fullName: true, preferredLanguage: true },
    });
    const { sendWebhookDisabledEmail } = await import('@/services/emailService');
    for (const a of admins) {
      try {
        await sendWebhookDisabledEmail({
          to: a.email,
          fullName: a.fullName,
          locale: a.preferredLanguage,
          userId: a.id,
          orgId: hook.orgId,
          url: hook.url,
          reason,
        });
      } catch (e) {
        logger.error('Webhook auto-disable notice failed to send', { webhookId: hook.id, error: String(e) });
      }
    }
  },
  now: () => new Date(),
};

/** The `webhook.deliver` job body (registered in src/jobs/index.ts). */
export function runWebhookDelivery(
  job: { eventId: string; webhookId: string },
  attempt: number,
  maxAttempts: number,
): Promise<DeliveryOutcomeName> {
  return runDeliveryAttempt(deps, job, attempt, maxAttempts);
}

// ── Admin side ──────────────────────────────────────────────────────────────

export type ReplayResult = { ok: true; queued: number } | { ok: false; reason: 'not_found' | 'disabled' | 'event_gone' };

async function replayableHook(webhookId: string, orgId: string | null) {
  const hook = await prisma.webhook.findFirst({ where: { id: webhookId, orgId }, select: { id: true, orgId: true, events: true, companyId: true, sourceId: true } });
  if (!hook) return null;
  return hook;
}

async function isLive(webhookId: string, orgId: string | null): Promise<boolean> {
  return (await prisma.webhook.count({ where: { id: webhookId, ...liveSubscriptionsWhere(orgId) } })) > 0;
}

/** Re-send the event of one recorded delivery to its hook. `orgId` is the caller's. */
export async function replayDelivery(deliveryRowId: string, orgId: string | null): Promise<ReplayResult> {
  const row = await prisma.webhookDelivery.findFirst({ where: { id: deliveryRowId, orgId }, select: { id: true, webhookId: true, eventId: true } });
  if (!row) return { ok: false, reason: 'not_found' };
  if (!(await replayableHook(row.webhookId, orgId))) return { ok: false, reason: 'not_found' };
  // A paused or auto-disabled hook would skip the job anyway; say so instead.
  if (!(await isLive(row.webhookId, orgId))) return { ok: false, reason: 'disabled' };
  if (!(await prisma.domainEvent.count({ where: { id: row.eventId } }))) return { ok: false, reason: 'event_gone' };
  await enqueueDelivery(row.eventId, row.webhookId, orgId, `${row.id}:${Date.now()}`);
  return { ok: true, queued: 1 };
}

/** Re-send the hook's last `count` subscribed events, from the `DomainEvent` record. */
export async function replayRecentEvents(webhookId: string, orgId: string | null, count: number): Promise<ReplayResult> {
  const hook = await replayableHook(webhookId, orgId);
  if (!hook) return { ok: false, reason: 'not_found' };
  if (!(await isLive(webhookId, orgId))) return { ok: false, reason: 'disabled' };
  const names = Array.isArray(hook.events) ? (hook.events as unknown[]).filter((e): e is string => typeof e === 'string') : [];
  if (names.length === 0) return { ok: true, queued: 0 };
  // An owned (company or source) hook replays only what fan-out would have
  // sent it (#2006): filtered BEFORE the `count`, so "the last N" means its last N.
  const owned = Boolean(hook.companyId || hook.sourceId);
  const candidates = await prisma.domainEvent.findMany({
    where: { orgId, name: { in: names } },
    orderBy: { createdAt: 'desc' },
    take: owned ? count * 10 : count,
    select: { id: true, name: true, orgId: true, payload: true },
  });
  const events: { id: string }[] = [];
  for (const e of candidates) {
    if (events.length >= count) break;
    if (owned && !(await ownerReceiverCheck({ ...e, payload: e.payload as Record<string, unknown> })(hook))) continue;
    events.push(e);
  }
  const stamp = Date.now();
  // Oldest first, so the receiver sees them in the order they happened.
  for (const e of events.reverse()) await enqueueDelivery(e.id, webhookId, orgId, `n:${stamp}`);
  return { ok: true, queued: events.length };
}

export const DELIVERY_LIST_SELECT = {
  id: true,
  eventId: true,
  eventName: true,
  deliveryId: true,
  attempt: true,
  status: true,
  responseCode: true,
  responseBody: true,
  error: true,
  durationMs: true,
  createdAt: true,
} as const;

/** The hook's most recent attempts, newest first. `orgId` is the caller's. */
export async function listDeliveries(webhookId: string, orgId: string | null, limit: number) {
  return prisma.webhookDelivery.findMany({
    where: { webhookId, orgId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: DELIVERY_LIST_SELECT,
  });
}
