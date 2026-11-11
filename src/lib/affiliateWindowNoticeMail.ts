// The partner's window-notice mail (#3556, docs/affiliate-module.md "Window notice").
//
// ONE MAIL PER PARTNER AND RUN, listing every customer whose notice came due in
// that run — a partner whose customers signed up in the same week would
// otherwise get a pile of near-identical mails on one morning. The job
// (src/lib/jobs/affiliateWindowNotices.ts) decides who and which customers and
// claims them; this module only renders and hands the mail to the router.
//
// What the mail carries, and what it never does: the customer as the partner
// already sees it in the portal (its label, else its opaque reference) and the
// day its window ends, read in the partner's language. No amount, no payment,
// nothing about the customer as a person.
//
// Through the router (#1711): the copy is built here and sealed in the job, sent
// as-is under the category `affiliate-window-ending` (task_reminders,
// src/lib/emailGroups.ts). The partner portal has no bell, so the channel is
// e-mail only; the portal shows the same date in its own column (#3557).

import { createHash } from 'node:crypto';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { emailDictionary } from '@/i18n/emailDictionary';
import { intlLocaleFor } from '@/lib/interviewRequests';
import { notifyEvent } from '@/lib/notifications/router';
import { appUrlFor, brandHeader, ctaBlock, emailBrand, esc } from '@/services/emailService';

export const WINDOW_NOTICE_CATEGORY = 'affiliate-window-ending';

export interface WindowNoticeItem {
  customerId: string;
  /** The label the admin gave the customer, else its reference — what the portal shows. */
  name: string;
  endsAt: Date;
}

/**
 * The router's dedupe key for one mail: the partner and exactly the customers it
 * names. A retried job that re-sends the same claim is absorbed by the ledger;
 * a later run that claims other customers is a different mail.
 */
export function windowNoticeDedupeKey(partnerId: string, items: readonly WindowNoticeItem[]): string {
  const ids = items.map((i) => i.customerId).sort().join(',');
  return `affiliate-window:${partnerId}:${createHash('sha256').update(ids).digest('hex').slice(0, 24)}`;
}

export async function sendAffiliateWindowNotice(input: {
  userId: string;
  partnerId: string;
  fullName: string;
  locale: string | null;
  orgId: string;
  items: readonly WindowNoticeItem[];
}) {
  if (input.items.length === 0) return null;
  const locale: Locale = isLocale(input.locale ?? undefined) ? (input.locale as Locale) : defaultLocale;
  const brand = await emailBrand(input.orgId);
  const base = await appUrlFor(input.orgId);
  const M = (await emailDictionary(locale, input.orgId)).affiliateWindowEmail;
  // A calendar day in UTC — the engine's window ends are UTC instants, and the
  // portal prints the same day the same way.
  const day = new Intl.DateTimeFormat(intlLocaleFor(locale), { dateStyle: 'long', timeZone: 'UTC' });
  const rows = input.items
    // Replacer functions: a label is admin-written text, and a `$&` in it must not
    // be read as a replacement pattern.
    .map((i) => `<li style="margin:4px 0;">${esc(M.item.replace('{customer}', () => i.name).replace('{date}', () => day.format(i.endsAt)))}</li>`)
    .join('');

  return notifyEvent(input.userId, 'affiliate.windowEnding', { count: String(input.items.length) }, {
    channels: ['email'],
    orgId: input.orgId,
    dedupeKey: windowNoticeDedupeKey(input.partnerId, input.items),
    email: {
      category: WINDOW_NOTICE_CATEGORY,
      locale,
      fromName: brand.name,
      subject: M.subject,
      html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(M.heading))}
        <p>${esc(M.greeting.replace('{name}', () => input.fullName))}</p>
        <p>${esc(M.body)}</p>
        <ul style="padding-left:20px;">${rows}</ul>
        <p style="color:#666;font-size:13px;">${esc(M.hint)}</p>
        ${ctaBlock(brand, `${base}/affiliate/customers`, esc(M.cta))}
      </div>
    `,
    },
  });
}
