// Fan-out's company check (#2006). Server-only.
//
// A company-registered hook receives an event only when (1) the event is in
// COMPANY_WEBHOOK_EVENTS and (2) the event's subject record belongs to the
// hook's company, read from the database at delivery time. Anything that
// cannot be resolved — an unknown event, a payload without the subject id, a
// record that is gone — is NOT delivered: fail closed. An org-wide hook
// (`companyId` null) is untouched by all of this.
import { prisma } from '@/lib/prisma';
import { COMPANY_EVENT_SUBJECT, isCompanyWebhookEvent } from '@/lib/companyWebhookRule';

/** The company the event's subject belongs to, or null when it cannot be said. */
export async function eventCompanyId(event: { name: string; orgId: string | null; payload: Record<string, unknown> }): Promise<string | null> {
  if (!isCompanyWebhookEvent(event.name)) return null;
  const { key, model } = COMPANY_EVENT_SUBJECT[event.name];
  const id = event.payload[key];
  if (typeof id !== 'string' || !id) return null;
  // An org-less event has no tenant to look the subject up in: undeliverable
  // to a company hook, by the same fail-closed rule.
  const orgId = event.orgId;
  if (!orgId) return null;
  const where = { id, orgId };
  switch (model) {
    case 'company':
      return (await prisma.company.findFirst({ where, select: { id: true } }))?.id ?? null;
    case 'application':
      return (await prisma.application.findFirst({ where, select: { companyId: true } }))?.companyId ?? null;
    case 'interviewRequest':
      return (await prisma.interviewRequest.findFirst({ where, select: { companyId: true } }))?.companyId ?? null;
    case 'requisition':
      return (await prisma.requisition.findFirst({ where, select: { companyId: true } }))?.companyId ?? null;
    case 'offer':
      return (await prisma.offer.findFirst({ where: { id, relation: { orgId } }, select: { companyId: true } }))?.companyId ?? null;
  }
}

/**
 * A memoised "may this hook receive this event?" for one event: the subject is
 * resolved at most once however many company hooks the tenant has.
 */
export function companyReceiverCheck(event: { name: string; orgId: string | null; payload: Record<string, unknown> }) {
  let resolved: Promise<string | null> | null = null;
  return async (hook: { companyId: string | null }): Promise<boolean> => {
    if (!hook.companyId) return true;
    resolved ??= eventCompanyId(event);
    return (await resolved) === hook.companyId;
  };
}
