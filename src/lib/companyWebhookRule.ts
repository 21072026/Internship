// Which events a COMPANY owner's own webhook may subscribe to (#2006).
// Dependency-free.
//
// A company-registered hook (`Webhook.companyId`) is limited to the hiring
// events whose subject belongs to exactly one company — and fan-out delivers
// one only when that company is the hook's (src/lib/companyWebhookScope.ts).
// Everything else on the bus (stage changes of a mentorship, interactions,
// meetings, evaluations …) is the programme's and never reaches a company
// hook. A subscription to anything outside this list is REFUSED (403
// `event_above_ceiling`), never silently trimmed.

export const COMPANY_WEBHOOK_EVENTS = [
  'application.stage_changed',
  'company_interest.changed',
  'interview_request.created',
  'interview_request.approved',
  'interview_request.declined',
  'interview_request.scheduled',
  'interview_request.cancelled',
  'interview_panel.outcome',
  'offer.sent',
  'offer.withdrawn',
  'offer.accepted',
  'offer.declined',
  'offer.expired',
  'requisition.filled',
] as const;

export type CompanyWebhookEvent = (typeof COMPANY_WEBHOOK_EVENTS)[number];

export function isCompanyWebhookEvent(name: string): name is CompanyWebhookEvent {
  return (COMPANY_WEBHOOK_EVENTS as readonly string[]).includes(name);
}

export type EventCeilingCheck = { ok: true } | { ok: false; above: string[] };

export function checkCompanyEventCeiling(events: readonly string[]): EventCeilingCheck {
  const above = events.filter((e) => !isCompanyWebhookEvent(e));
  return above.length === 0 ? { ok: true } : { ok: false, above };
}

/** The payload field that names the event's subject, and which record it is. */
export const COMPANY_EVENT_SUBJECT: Record<CompanyWebhookEvent, { key: string; model: 'application' | 'interviewRequest' | 'offer' | 'requisition' | 'company' }> = {
  'application.stage_changed': { key: 'applicationId', model: 'application' },
  'company_interest.changed': { key: 'companyId', model: 'company' },
  'interview_request.created': { key: 'requestId', model: 'interviewRequest' },
  'interview_request.approved': { key: 'requestId', model: 'interviewRequest' },
  'interview_request.declined': { key: 'requestId', model: 'interviewRequest' },
  'interview_request.scheduled': { key: 'requestId', model: 'interviewRequest' },
  'interview_request.cancelled': { key: 'requestId', model: 'interviewRequest' },
  'interview_panel.outcome': { key: 'applicationId', model: 'application' },
  'offer.sent': { key: 'offerId', model: 'offer' },
  'offer.withdrawn': { key: 'offerId', model: 'offer' },
  'offer.accepted': { key: 'offerId', model: 'offer' },
  'offer.declined': { key: 'offerId', model: 'offer' },
  'offer.expired': { key: 'offerId', model: 'offer' },
  'requisition.filled': { key: 'requisitionId', model: 'requisition' },
};
