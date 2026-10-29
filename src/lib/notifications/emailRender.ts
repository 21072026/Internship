// The ONE renderer of a notification event's e-mail (#1719).
//
// Three callers, one code path — which is the point:
//   * the `notification.email` job (src/jobs/index.ts), which the router's
//     e-mail channel enqueues (src/lib/notifications/router.ts);
//   * POST /api/admin/notification-templates/preview — the editor's live pane;
//   * POST /api/admin/notification-templates/test — "send me a test".
// The editor passes its unsaved `draft`, the job passes none (the stored
// template, else the code default — resolveTemplate()). Everything around the
// body — the brand header, the call-to-action into the app, the From name and
// the mail category — is decided here and nowhere else, so what the preview
// pane shows is what arrives. sendEmail() then adds what every mail gets (the
// unsubscribe footer, List-* headers, the EmailLog row).
//
// SERVER-ONLY: reads the org's brand and the settings chain.

import { emailDictionary } from '@/i18n/emailDictionary';
import { isLocale, defaultLocale, type Locale } from '@/i18n/config';
import { appUrlFor, brandHeader, ctaBlock, emailBrand, esc } from '@/services/emailService';
import { resolveTemplate, type ResolvedTemplate } from '@/lib/notifications/templates';
import type { MergeValues } from '@/lib/notifications/templateRender';
export { EVENT_MAIL_CATEGORY } from '@/lib/notifications/eventMailRule';


export interface NotificationEmailInput {
  eventKey: string;
  locale: string | null | undefined;
  orgId: string | null | undefined;
  programId?: string | null;
  params?: Record<string, unknown>;
  recipientName?: string | null;
  /** A path inside the recipient's product ("/mentor/…"); made absolute here. */
  link?: string | null;
  draft?: { subject: string; body: string };
}

export interface RenderedNotificationEmail {
  subject: string;
  html: string;
  fromName: string;
  locale: Locale;
  source: ResolvedTemplate['source'];
  fallback?: ResolvedTemplate['fallback'];
}

function mergeValues(params: Record<string, unknown> | undefined): MergeValues {
  const out: MergeValues = {};
  for (const [k, v] of Object.entries(params ?? {})) if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  return out;
}

export async function renderNotificationEmail(input: NotificationEmailInput): Promise<RenderedNotificationEmail> {
  const locale: Locale = isLocale(input.locale) ? input.locale : defaultLocale;
  const [brand, base, dict] = await Promise.all([emailBrand(input.orgId), appUrlFor(input.orgId), emailDictionary(locale, input.orgId)]);
  const t = await resolveTemplate(input.eventKey, locale, {
    orgId: input.orgId,
    programId: input.programId,
    params: mergeValues(input.params),
    recipientName: input.recipientName,
    brand: { name: brand.name, url: base },
    draft: input.draft,
  });
  // Only a relative path becomes a button: the link is ours, never a URL a
  // payload could point anywhere.
  const link = input.link && input.link.startsWith('/') && !input.link.startsWith('//') ? `${base}${input.link}` : null;
  const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(t.subject))}
        ${t.html}
        ${link ? ctaBlock(brand, esc(link), esc(dict.notifications.emailOpenCta)) : ''}
      </div>
    `;
  return { subject: t.subject, html, fromName: brand.name, locale, source: t.source, ...(t.fallback ? { fallback: t.fallback } : {}) };
}
