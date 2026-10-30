import { sendEmail, emailBrand, brandHeader, esc } from '@/services/emailService';
import { emailDictionary } from '@/i18n/emailDictionary';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';

// The mails to a partner applicant (docs/affiliate-module.md, #3361). Sent with
// a raw sendEmail() on purpose, and listed under `allowed` in
// scripts/notify-baseline.json (check:notify, #1711): the recipient is an
// AffiliateApplication and nothing else — no User row exists to hold a
// preference, a ledger entry or a catalogue event, so notifyEvent() has nobody
// to address. Kept out of emailService.ts so that file's count only shrinks.

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
  const M = (await emailDictionary(isLocale(locale ?? undefined) ? (locale as Locale) : defaultLocale, orgId)).affiliateApplicationEmail;
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
