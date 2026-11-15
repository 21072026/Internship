// Which product module each public webhook event belongs to (MKT-6b, Refs #2348).
//
// The same rule as API key scopes (src/lib/apiScopes.ts, SCOPE_CAPABILITY): a
// MARKETING org has no internship hiring, evaluations or mentorship modules, so
// it may neither subscribe to their events (admin form, POST /api/v1/hooks,
// a SOURCE's self-served hook) nor have one delivered. A subscription that
// already names one keeps its row; the event is IGNORED when it is read, never
// deleted — the same choice as a stored scope.
//
// A Record over every public event (PublicEventName): a new public event fails
// the typecheck until it is mapped, and `npm run check:api-scope-capabilities`
// fails a stale or unmapped entry in CI.
//
//   pipeline    — people, their pipeline records and meetings: a MARKETING lead's
//                 owner, stage moves, hand-offs (mentorship.transferred) and logged
//                 interactions run on the same rows, so these stay available.
//   placements  — requisitions, applications, interview requests and panels,
//                 offers, company interest: internship hiring.
//   evaluations — evaluations and weekly reports.
//   mentorship  — the public mentor application, shared goals, a pairing's
//                 agreed end date.
//   documents   — the person's document file.
//
// Client-safe: types only from the catalogue, no zod, no prisma.

import type { PublicEventName } from '@/lib/events/catalog';
import type { VerticalCapability } from '@/lib/verticals';

export const WEBHOOK_EVENT_CAPABILITY: Record<PublicEventName, VerticalCapability> = {
  'application.created': 'mentorship',
  'pipeline.stage_change': 'pipeline',
  'mentorship.created': 'pipeline',
  'interaction.logged': 'pipeline',
  'evaluation.added': 'evaluations',
  'meeting.scheduled': 'pipeline',
  'meeting.rescheduled': 'pipeline',
  'meeting.cancelled': 'pipeline',
  'interview_panel.completed': 'placements',
  'interview_panel.outcome': 'placements',
  'interview_request.scheduled': 'placements',
  'interview_request.cancelled': 'placements',
  'offer.accepted': 'placements',
  'offer.declined': 'placements',
  'requisition.filled': 'placements',
  'mentorship.lifecycle_changed': 'pipeline',
  'application.stage_changed': 'placements',
  'mentorship.transferred': 'pipeline',
  'offer.sent': 'placements',
  'offer.withdrawn': 'placements',
  'offer.expired': 'placements',
  'interview_request.created': 'placements',
  'interview_request.approved': 'placements',
  'interview_request.declined': 'placements',
  'company_interest.changed': 'placements',
  'weekly_report.submitted': 'evaluations',
  'document.uploaded': 'documents',
  'goal.completed': 'mentorship',
  'meeting.attendance_recorded': 'pipeline',
  'user.created': 'pipeline',
  'mentorship.ending_soon': 'mentorship',
  'mentorship.extended': 'mentorship',
  'requisition.status_changed': 'placements',
};

function capabilityOf(event: string): VerticalCapability | undefined {
  return (WEBHOOK_EVENT_CAPABILITY as Record<string, VerticalCapability>)[event];
}

/** Whether an org with these capabilities may subscribe to / receive `event`. */
export function webhookEventAvailable(event: string, capabilities: readonly VerticalCapability[]): boolean {
  const cap = capabilityOf(event);
  return cap !== undefined && capabilities.includes(cap);
}

/** The subscribable events of an org with these capabilities, in the order given. */
export function webhookEventsForCapabilities<E extends string>(events: readonly E[], capabilities: readonly VerticalCapability[]): E[] {
  return events.filter((e) => webhookEventAvailable(e, capabilities));
}

/** The stored events of a subscription that this org's product does not have (ignored, never deleted). */
export function ignoredWebhookEvents(events: readonly string[], capabilities: readonly VerticalCapability[]): string[] {
  return events.filter((e) => capabilityOf(e) !== undefined && !capabilities.includes(capabilityOf(e)!));
}
