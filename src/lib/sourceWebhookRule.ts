// Which events a SOURCE owner's own webhook may subscribe to (#2006).
// Dependency-free. The twin of src/lib/companyWebhookRule.ts.
//
// A source-registered hook (`Webhook.sourceId`) is limited to the events whose
// subject is one candidate — a MENTEE account, or a mentorship of one — and
// fan-out delivers one only when that candidate was referred by the hook's
// source (src/lib/sourceWebhookScope.ts). Hiring records (applications,
// offers, interview requests) are the company's, and interactions, meetings,
// goals and reports are the pair's: none of them reaches a source hook. A
// subscription to anything outside this list is REFUSED (403
// `event_above_ceiling`), never silently trimmed.

export const SOURCE_WEBHOOK_EVENTS = [
  'user.created',
  'mentorship.created',
  'pipeline.stage_change',
  'mentorship.lifecycle_changed',
  'mentorship.transferred',
  'mentorship.ending_soon',
  'mentorship.extended',
] as const;

export type SourceWebhookEvent = (typeof SOURCE_WEBHOOK_EVENTS)[number];

export function isSourceWebhookEvent(name: string): name is SourceWebhookEvent {
  return (SOURCE_WEBHOOK_EVENTS as readonly string[]).includes(name);
}

export type EventCeilingCheck = { ok: true } | { ok: false; above: string[] };

export function checkSourceEventCeiling(events: readonly string[]): EventCeilingCheck {
  const above = events.filter((e) => !isSourceWebhookEvent(e));
  return above.length === 0 ? { ok: true } : { ok: false, above };
}

/** The payload field that names the event's candidate, and which record it is. */
export const SOURCE_EVENT_SUBJECT: Record<SourceWebhookEvent, { key: string; model: 'mentee' | 'relation' }> = {
  'user.created': { key: 'userId', model: 'mentee' },
  'mentorship.created': { key: 'relationId', model: 'relation' },
  'pipeline.stage_change': { key: 'relationId', model: 'relation' },
  'mentorship.lifecycle_changed': { key: 'relationId', model: 'relation' },
  'mentorship.transferred': { key: 'relationId', model: 'relation' },
  'mentorship.ending_soon': { key: 'relationId', model: 'relation' },
  'mentorship.extended': { key: 'relationId', model: 'relation' },
};
