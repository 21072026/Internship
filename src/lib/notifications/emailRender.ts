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
import { appUrlFor, brandHeader, ctaBlock, emailBrand, esc, invitationBody } from '@/services/emailService';
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
  /**
   * Account mails only (#3399): the absolute one-time link the sender built
   * from its token. Never a merge tag — drawn here as the button and the
   * "copy this link" line whatever the template says. Omitted (preview, test
   * send), a dead sample link of the same shape stands in.
   */
  actionUrl?: string;
  /** Account mails only: the stored template is not consulted (SET_INITIAL). */
  bespokeOnly?: boolean;
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

// ── Account mails (#3399) ────────────────────────────────────────────────────
// Invitation, password reset and e-mail verification carry a one-time token,
// so the link is the mail's whole point and must survive any template: the
// template replaces the wording (subject, heading, body) and nothing else. With
// no stored template the mail is the bespoke one it always was.

const ACCOUNT_MAIL_PATHS = {
  'account.invitation': '/auth/register',
  'account.passwordReset': '/auth/reset',
  'account.verification': '/auth/verify',
} as const;
type AccountMailEvent = keyof typeof ACCOUNT_MAIL_PATHS;

export function isAccountMailEvent(key: string): key is AccountMailEvent {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_MAIL_PATHS, key);
}

type Dict = Awaited<ReturnType<typeof emailDictionary>>;

interface AccountCopy {
  subject: string;
  heading: string;
  bodyHtml: string;
  cta: string;
  expiry: string;
  copyLink: string;
}

/** The bespoke copy of one account mail, and the label its role param renders as. */
function accountCopy(event: AccountMailEvent, dict: Dict, brandName: string, params: MergeValues, bespokeOnly: boolean): AccountCopy {
  const N = dict.notifications;
  const name = params.name === null || params.name === undefined ? '' : String(params.name);
  if (event === 'account.invitation') {
    const I = N.invitationEmail;
    // `role` is already the label (renderNotificationEmail), which passes through.
    const { roleLabel, bodyBefore, bodyAfter } = invitationBody(I, String(params.role ?? ''));
    return {
      subject: I.subject.replace('{brand}', brandName),
      heading: I.heading.replace('{brand}', brandName),
      bodyHtml: `<p>${esc(bodyBefore)}<strong>${esc(roleLabel)}</strong>${esc(bodyAfter)}</p>
        <p>${esc(I.ctaIntro)}</p>`,
      cta: I.cta,
      expiry: I.expiry,
      copyLink: I.copyLink,
    };
  }
  if (event === 'account.passwordReset') {
    const P = N.passwordResetEmail;
    // SET_INITIAL rides the reset event's sender but keeps its own copy.
    const V = bespokeOnly ? P.setInitial : P.reset;
    return {
      subject: V.subject.replace('{brand}', brandName),
      heading: V.heading,
      bodyHtml: `${name ? `<p>${esc(P.greeting.replace('{name}', name))}</p>` : ''}
        <p>${esc(V.body.replace('{brand}', brandName))}</p>`,
      cta: V.cta,
      expiry: V.expiry,
      copyLink: P.copyLink,
    };
  }
  const V = N.verificationEmail;
  return {
    subject: V.subject.replace('{brand}', brandName),
    heading: V.heading,
    bodyHtml: `${name ? `<p>${esc(V.greeting.replace('{name}', name))}</p>` : ''}
        <p>${esc(V.body)}</p>`,
    cta: V.cta,
    expiry: V.expiry,
    copyLink: V.copyLink,
  };
}

export async function renderNotificationEmail(input: NotificationEmailInput): Promise<RenderedNotificationEmail> {
  const locale: Locale = isLocale(input.locale) ? input.locale : defaultLocale;
  const [brand, base, dict] = await Promise.all([emailBrand(input.orgId), appUrlFor(input.orgId), emailDictionary(locale, input.orgId)]);
  const params = mergeValues(input.params);
  // The invitation's {{role}} is the invitee's-language label, not the enum.
  if (input.eventKey === 'account.invitation') params.role = invitationBody(dict.notifications.invitationEmail, String(params.role ?? '')).roleLabel;
  if (isAccountMailEvent(input.eventKey) && input.bespokeOnly) {
    return accountMail(input.eventKey, input, { subject: '', html: '', source: 'default' }, brand, base, dict, params, locale);
  }
  const t = await resolveTemplate(input.eventKey, locale, {
    orgId: input.orgId,
    programId: input.programId,
    params,
    recipientName: input.recipientName,
    brand: { name: brand.name, url: base },
    draft: input.draft,
  });
  if (isAccountMailEvent(input.eventKey)) return accountMail(input.eventKey, input, t, brand, base, dict, params, locale);
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

function accountMail(
  event: AccountMailEvent,
  input: NotificationEmailInput,
  t: ResolvedTemplate,
  brand: Awaited<ReturnType<typeof emailBrand>>,
  base: string,
  dict: Dict,
  params: MergeValues,
  locale: Locale,
): RenderedNotificationEmail {
  const copy = accountCopy(event, dict, brand.name, params, !!input.bespokeOnly);
  const own = t.source !== 'default';
  const subject = own ? t.subject : copy.subject;
  const url = esc(input.actionUrl ?? `${base}${ACCOUNT_MAIL_PATHS[event]}?token=preview`);
  const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(own ? t.subject : copy.heading))}
        ${own ? t.html : copy.bodyHtml}
        <a href="${url}" style="
          display: inline-block;
          background-color: ${brand.accent};
          color: white;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 6px;
          margin: 16px 0;
        ">
          ${esc(copy.cta)}
        </a>
        <p style="color: #6b7280; font-size: 14px;">
          ${esc(copy.expiry)}
        </p>
        <p style="color: #6b7280; font-size: 12px;">
          ${esc(copy.copyLink)} ${url}
        </p>
      </div>
    `;
  return { subject, html, fromName: brand.name, locale, source: t.source, ...(t.fallback ? { fallback: t.fallback } : {}) };
}
