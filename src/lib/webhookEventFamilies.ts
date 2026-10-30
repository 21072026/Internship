// The families the admin's webhook event picker groups by (#1998).
// Dependency-free and client-safe.
//
// One rule: the event's name decides its family, from an explicit table for
// the names that are not grouped by their own prefix (an `application.*` that
// is a hiring row versus the public mentor-application form). A name no rule
// covers falls into `other`, and the unit spec fails on that for every public
// event — a new event has to be placed here.

export const WEBHOOK_EVENT_FAMILIES = ['pipeline', 'mentorship', 'activity', 'meetings', 'interviews', 'hiring', 'people', 'other'] as const;
export type WebhookEventFamily = (typeof WEBHOOK_EVENT_FAMILIES)[number];

const BY_NAME: Record<string, WebhookEventFamily> = {
  'application.created': 'pipeline',
  'pipeline.stage_change': 'pipeline',
  'application.stage_changed': 'hiring',
  'interaction.logged': 'activity',
  'evaluation.added': 'activity',
};

const BY_PREFIX: Record<string, WebhookEventFamily> = {
  mentorship: 'mentorship',
  meeting: 'meetings',
  interview_request: 'interviews',
  interview_panel: 'interviews',
  offer: 'hiring',
  requisition: 'hiring',
  company_interest: 'hiring',
  weekly_report: 'activity',
  document: 'activity',
  goal: 'activity',
  user: 'people',
};

export function webhookEventFamily(name: string): WebhookEventFamily {
  return BY_NAME[name] ?? BY_PREFIX[name.split('.')[0]] ?? 'other';
}

/** The names grouped by family, families in display order, names in their given order; empty families left out. */
export function groupWebhookEvents(names: readonly string[]): { family: WebhookEventFamily; events: string[] }[] {
  return WEBHOOK_EVENT_FAMILIES.map((family) => ({ family, events: names.filter((n) => webhookEventFamily(n) === family) })).filter(
    (g) => g.events.length > 0,
  );
}
