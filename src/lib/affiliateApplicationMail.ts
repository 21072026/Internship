// The acknowledgement of a public partner application (#3361).
//
// Its own module, not a function in src/services/emailService.ts, for one
// reason: the recipient is an AffiliateApplication and nothing else — no User
// row exists, so there is no person the notification router (notifyEvent())
// could address, no preference to read and no catalogue event to render. That
// makes it a deliberate raw send, recorded with its reason in the `allowed`
// block of scripts/notify-baseline.json, rather than a site still waiting to
// move behind the router (`pending`, which only shrinks). Like the mentor
// application mail, the language is the one the form was shown in, and the
// copy goes through emailDictionary() so the org's product name reaches it.

import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { emailDictionary } from '@/i18n/emailDictionary';
import { brandHeader, emailBrand, esc, sendEmail } from '@/services/emailService';

export async function sendAffiliateApplicationReceivedEmail({
  to,
  firstName,
  locale,
  orgId,
}: {
  to: string;
  firstName: string;
  locale?: string | null;
  orgId: string;
}) {
  const brand = await emailBrand(orgId);
  const resolved: Locale = isLocale(locale ?? undefined) ? (locale as Locale) : defaultLocale;
  const M = (await emailDictionary(resolved, orgId)).affiliateApplicationEmail;
  await sendEmail({
    to,
    orgId,
    // no-user-row: the applicant is an AffiliateApplication and nothing else —
    // no User row exists to hold a preference, so no footer is emitted.
    category: 'affiliate-application-received',
    locale,
    fromName: brand.name,
    subject: M.received.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(M.received.heading))}
        <p>${esc(M.greeting.replace('{name}', firstName))}</p>
        <p>${esc(M.received.body)}</p>
      </div>
    `,
  });
}
