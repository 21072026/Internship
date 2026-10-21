import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getOrgBranding } from '@/lib/orgBranding';
import { appOriginForOrg } from '@/lib/orgLinkOrigin';
import { dictionaries } from '@/i18n/dictionaries';
import { isLocale, defaultLocale, type Locale } from '@/i18n/config';
import { eventDef } from '@/lib/notifications/catalog';
import {
  escapeHtml,
  firstNameOf,
  interpolateDefault,
  pickTemplateRow,
  renderStoredTemplate,
  sanitizeSubject,
  type MergeValues,
  type RenderRefusal,
} from '@/lib/notifications/templateRender';

// Which words a notification is sent with (#1718): a programme's row → its
// org's row → the CODE DEFAULT, per recipient locale. The code default is the
// dictionary's `notifications.events.<key>` line in that same locale, so a
// locale nobody wrote never borrows another language's row: a German org's
// recipients do not start receiving the Turkish override.
//
// FAIL SAFE. A stored row that throws, whose subject is empty or names a tag
// the event does not carry, or whose body sanitises to nothing, is not used:
// the code default is, and the reason comes back (`fallback`) and is logged. A
// bad template must never silence a notification.
//
// Programmes do not exist yet (#1618): `programId` is accepted and matched,
// and every stored row today is the org-wide one (programId '').
//
// No rows, no change: an org that never wrote a template resolves to exactly
// the code default.

export type TemplateSource = 'program' | 'org' | 'default';

export interface ResolvedTemplate {
  subject: string;
  html: string;
  source: TemplateSource;
  /** Set when a stored row existed but could not be used. */
  fallback?: RenderRefusal | 'render_error' | 'read_error';
  templateId?: string;
}

export interface TemplateContext {
  orgId: string | null | undefined;
  programId?: string | null;
  /** The event's own payload (the catalogue entry's `params`). */
  params?: MergeValues;
  /** Fills `{{recipient.firstName}}`. */
  recipientName?: string | null;
  /** Fills `{{brand.name}}` / `{{brand.url}}`; read from the org when omitted. */
  brand?: { name: string; url: string };
}

/** The code default of one event, in one locale: subject and body from the dictionary line. */
export function codeDefault(eventKey: string, locale: Locale, values: MergeValues): { subject: string; html: string } {
  const events = dictionaries[locale].notifications.events as Record<string, string>;
  const line = interpolateDefault(events[eventKey] ?? dictionaries[locale].notifications.generic, values);
  return { subject: sanitizeSubject(line), html: `<p>${escapeHtml(line)}</p>` };
}

async function brandFor(orgId: string | null | undefined): Promise<{ name: string; url: string }> {
  const [b, url] = await Promise.all([getOrgBranding(orgId ?? null), appOriginForOrg(orgId)]);
  return { name: b.name, url };
}

export async function resolveTemplate(eventKey: string, localeIn: string | null | undefined, ctx: TemplateContext): Promise<ResolvedTemplate> {
  const def = eventDef(eventKey);
  if (!def) throw new Error(`Unknown notification event: ${eventKey}`);
  const locale: Locale = isLocale(localeIn) ? localeIn : defaultLocale;
  const params = ctx.params ?? {};
  const fallbackDefault = (fallback?: ResolvedTemplate['fallback']): ResolvedTemplate => ({
    ...codeDefault(eventKey, locale, params),
    source: 'default',
    ...(fallback ? { fallback } : {}),
  });
  if (!ctx.orgId) return fallbackDefault();

  let rows: { id: string; programId: string; subject: string; body: string }[];
  try {
    rows = await prisma.notificationTemplate.findMany({
      where: {
        orgId: ctx.orgId,
        eventKey,
        locale,
        programId: { in: ctx.programId ? ['', ctx.programId] : [''] },
      },
      select: { id: true, programId: true, subject: true, body: true },
    });
  } catch (e) {
    logger.error('notification_template.read_failed', { eventKey, error: e instanceof Error ? e.message : String(e) });
    return fallbackDefault('read_error');
  }
  const row = pickTemplateRow(rows, ctx.programId);
  if (!row) return fallbackDefault();

  try {
    const brand = ctx.brand ?? (await brandFor(ctx.orgId));
    const values: MergeValues = {
      ...params,
      'brand.name': brand.name,
      'brand.url': brand.url,
      'recipient.firstName': firstNameOf(ctx.recipientName),
    };
    const out = renderStoredTemplate(row, def.params, values);
    if (!out.ok) {
      logger.warning('notification_template.fallback', { eventKey, locale, templateId: row.id, reason: out.reason });
      return { ...fallbackDefault(out.reason), templateId: row.id };
    }
    return { subject: out.subject, html: out.html, source: row.programId ? 'program' : 'org', templateId: row.id };
  } catch (e) {
    logger.error('notification_template.render_failed', { eventKey, locale, templateId: row.id, error: e instanceof Error ? e.message : String(e) });
    return { ...fallbackDefault('render_error'), templateId: row.id };
  }
}
