// Render an in-app notification in the viewer's locale (#921).
//
// Contract: rows written through notify() carry `type` (an event key like
// "message.new") and `params` (interpolation values); the display string is the
// `notifications.events[type]` dictionary template with `{placeholders}`
// substituted. Legacy rows and announcements carry a pre-rendered `text`
// instead, which always wins. An unknown type without text falls back to a
// neutral string so a bad row can never crash the bell.
//
// Client-safe: no Prisma, no server-only imports — shared by NotificationBell,
// the /notifications page and browser notifications.
import type { Locale } from '@/i18n/config';
import { pipelineLabel, PIPELINE_STATUSES } from '@/lib/pipeline';

export interface RenderableNotification {
  type: string;
  text?: string | null;
  params?: unknown;
}

// The slice of the dictionary this helper needs (structural, so both the full
// server Dictionary and the ClientDictionary satisfy it).
export interface NotificationDict {
  notifications: {
    events: Record<string, string>;
    generic: string;
  };
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in values ? values[key] : m));
}

// Stage keys resolve to the viewer-locale label for the built-in pipeline;
// custom (per-org) stages ship their tenant-set label in params.*Label — those
// aren't translatable, they render as the tenant wrote them.
function stageDisplay(key: string, customLabel: string | undefined, locale: Locale): string {
  if ((PIPELINE_STATUSES as readonly string[]).includes(key)) return pipelineLabel(key, locale);
  return customLabel ?? key;
}

export function renderNotification(n: RenderableNotification, t: NotificationDict, locale: Locale): string {
  if (n.text) return n.text;

  const params: Record<string, unknown> =
    n.params && typeof n.params === 'object' && !Array.isArray(n.params) ? (n.params as Record<string, unknown>) : {};

  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || typeof v === 'number') values[k] = String(v);
  }
  // Stage-change payloads store stage KEYS (plus a label snapshot for custom
  // stages); swap in the localized/display label before interpolation.
  if (typeof params.from === 'string' && typeof params.to === 'string' && n.type.startsWith('stage.')) {
    values.from = stageDisplay(params.from, typeof params.fromLabel === 'string' ? params.fromLabel : undefined, locale);
    values.to = stageDisplay(params.to, typeof params.toLabel === 'string' ? params.toLabel : undefined, locale);
  }

  const template = t.notifications.events[n.type];
  if (template) return interpolate(template, values);
  return t.notifications.generic;
}
