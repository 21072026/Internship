// Fan-out's source check (#2006). Server-only. The twin of
// src/lib/companyWebhookScope.ts.
//
// A source-registered hook receives an event only when (1) the event is in
// SOURCE_WEBHOOK_EVENTS and (2) its candidate — the MENTEE account, or the
// mentee of the mentorship — was referred by the hook's source, read from the
// database at delivery time. Anything that cannot be resolved (an unknown
// event, a payload without the id, a record that is gone, an account that is
// not a MENTEE) is NOT delivered: fail closed. A hook without `sourceId` is
// untouched by all of this.
import { prisma } from '@/lib/prisma';
import { SOURCE_EVENT_SUBJECT, isSourceWebhookEvent } from '@/lib/sourceWebhookRule';

type ScopedEvent = { name: string; orgId: string | null; payload: Record<string, unknown> };

/** The source that referred the event's candidate, or null when it cannot be said. */
export async function eventSourceId(event: ScopedEvent): Promise<string | null> {
  if (!isSourceWebhookEvent(event.name)) return null;
  const { key, model } = SOURCE_EVENT_SUBJECT[event.name];
  const id = event.payload[key];
  if (typeof id !== 'string' || !id) return null;
  const orgId = event.orgId;
  if (!orgId) return null;
  if (model === 'mentee') {
    return (await prisma.user.findFirst({ where: { id, orgId, role: 'MENTEE' }, select: { sourceId: true } }))?.sourceId ?? null;
  }
  const relation = await prisma.mentorshipRelation.findFirst({ where: { id, orgId }, select: { mentee: { select: { sourceId: true } } } });
  return relation?.mentee.sourceId ?? null;
}

/**
 * A memoised "may this hook receive this event?" for one event: the candidate
 * is resolved at most once however many source hooks the tenant has.
 */
export function sourceReceiverCheck(event: ScopedEvent) {
  let resolved: Promise<string | null> | null = null;
  return async (hook: { sourceId: string | null }): Promise<boolean> => {
    if (!hook.sourceId) return true;
    resolved ??= eventSourceId(event);
    return (await resolved) === hook.sourceId;
  };
}
