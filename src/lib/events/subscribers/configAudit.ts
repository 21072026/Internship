// The configuration audit subscriber (#1699): every configuration event → one
// `AuditLog` row, so the audit trail (and the tenant's audit drain, which reads
// that table) is fed from the event stream rather than from each route.
//
// The row: `action` = the event name, `targetId` = the event's subject,
// `actorId` = the event's actor ('system' when none), `orgId` = the event's
// tenant — passed explicitly, never left to the middleware (a worker has no
// session, and a row without one reaches no drain; docs/audit-stream.md). An
// event with no tenant (a global setting) is written with `orgId: null`: it is
// the operator's, and the drain never folds it into anybody's stream.
//
// `detail` is `{"eventId":…,…payload}` as JSON. The payload is already the
// redacted diff (src/lib/events/diff.ts) and was validated against the
// catalogue on the way in, so nothing here masks anything a second time.
//
// AT-LEAST-ONCE: a container killed after the insert but before the job
// settled runs this again. The row is looked up by its action, target and the
// event id that opens its detail first, so a rerun writes nothing.

import type { SubscriberDefinition, DeliveredEvent } from '../subscribers';

/** The configuration events — the `config.*` family of #1699. */
export const CONFIG_AUDIT_EVENTS = [
  'org.config.changed',
  'setting.changed',
  'webhook.registered',
  'webhook.updated',
  'webhook.deleted',
  'apikey.created',
  'apikey.revoked',
] as const;

/** The AuditLog row an event becomes. Pure; the unit test pins it. */
export function auditRowFor(event: DeliveredEvent): {
  orgId: string | null;
  actorId: string;
  action: string;
  targetId: string | null;
  detail: string;
} {
  return {
    orgId: event.orgId,
    actorId: event.actorId || 'system',
    action: event.name,
    targetId: event.subjectId,
    detail: JSON.stringify({ eventId: event.id, ...event.payload }),
  };
}

export interface AuditStore {
  exists(row: { action: string; targetId: string | null; eventId: string }): Promise<boolean>;
  create(row: ReturnType<typeof auditRowFor>): Promise<unknown>;
}

// Prisma is imported lazily so the unit test can load this file without a client.
const prismaStore: AuditStore = {
  exists: async ({ action, targetId, eventId }) => {
    const { prisma } = await import('@/lib/prisma');
    const n = await prisma.auditLog.count({
      where: { action, targetId, detail: { startsWith: `{"eventId":${JSON.stringify(eventId)}` } },
    });
    return n > 0;
  },
  create: async (row) => {
    const { prisma } = await import('@/lib/prisma');
    return prisma.auditLog.create({
      data: { orgId: row.orgId, actorId: row.actorId, action: row.action, targetId: row.targetId, detail: row.detail },
    });
  },
};

/** `store` is injectable for the unit test only. */
export function createConfigAuditSubscriber(store: AuditStore = prismaStore): SubscriberDefinition {
  return {
    name: 'config-audit',
    events: CONFIG_AUDIT_EVENTS,
    handle: async (event) => {
      const row = auditRowFor(event);
      if (await store.exists({ action: row.action, targetId: row.targetId, eventId: event.id })) return;
      await store.create(row);
    },
  };
}

export const configAuditSubscriber = createConfigAuditSubscriber();
