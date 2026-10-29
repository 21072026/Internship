// What the template editor (#1719) may list and write. Pure and client-safe:
// the catalogue view, the sample payload a preview renders with, and the save
// check — the routes under /api/admin/notification-templates and the page share
// it, so the editor shows exactly the events and tags the server accepts.

import { NOTIFICATION_EVENTS, type NotificationEventDef } from '@/lib/notifications/catalog';
import { BODY_MAX, BRAND_TAGS, SUBJECT_MAX, renderStoredTemplate, type RenderRefusal } from '@/lib/notifications/templateRender';
import type { EmailGroupId } from '@/lib/emailGroups';

/**
 * The events a template can change: those whose mail is sent at all. A
 * template only rewrites the e-mail (the bell keeps the dictionary line), so an
 * in-app-only event has nothing to edit.
 */
export const EDITABLE_EVENTS: readonly NotificationEventDef[] = NOTIFICATION_EVENTS.filter((e) =>
  (e.defaultChannels as readonly string[]).includes('email'),
);

export function editableEvent(key: string): NotificationEventDef | null {
  return EDITABLE_EVENTS.find((e) => e.key === key) ?? null;
}

/** Editable events grouped by their e-mail group, in catalogue order. */
export function eventsByGroup(): { group: EmailGroupId; events: NotificationEventDef[] }[] {
  const out: { group: EmailGroupId; events: NotificationEventDef[] }[] = [];
  for (const e of EDITABLE_EVENTS) {
    let bucket = out.find((b) => b.group === e.emailGroup);
    if (!bucket) out.push((bucket = { group: e.emailGroup, events: [] }));
    bucket.events.push(e);
  }
  return out;
}

/** Every merge tag the event carries — its own params, then the brand tags. */
export function mergeTagsFor(def: Pick<NotificationEventDef, 'params'>): string[] {
  return [...def.params, ...BRAND_TAGS];
}

/**
 * The payload a preview and a test send render with: each param shown as its
 * own name in brackets, so the admin sees where each value lands without a
 * real person's data in it.
 */
export function samplePayload(def: Pick<NotificationEventDef, 'params'>): Record<string, string> {
  return Object.fromEntries(def.params.map((p) => [p, `[${p}]`]));
}

export type TemplateSaveRefusal = RenderRefusal | 'too_long';

/**
 * Would this template be USED when it is sent? The same check the resolver
 * applies at send time (renderStoredTemplate), run before the save so the
 * editor refuses a template that would silently fall back to the default.
 */
export function checkTemplateDraft(def: Pick<NotificationEventDef, 'params'>, draft: { subject: string; body: string }): TemplateSaveRefusal | null {
  if (draft.subject.length > SUBJECT_MAX || draft.body.length > BODY_MAX) return 'too_long';
  const out = renderStoredTemplate(draft, def.params, {
    ...samplePayload(def),
    'brand.name': 'Brand',
    'brand.url': 'https://brand.example',
    'recipient.firstName': 'Name',
  });
  return out.ok ? null : out.reason;
}
