// The two mails a partner applicant gets (#3361, #3362). They live outside
// src/services/emailService.ts because they are allowed raw sends in
// scripts/notify-baseline.json: the applicant is an AffiliateApplication row,
// never a User, so there is no recipient for notifyEvent() to resolve and no
// preference or catalogue event to apply.
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { emailDictionary } from '@/i18n/emailDictionary';
import { brandHeader, emailBrand, esc, sendEmail } from '@/services/emailService';

// The acknowledgement of a public partner application. Like the mentor
// application above, the applicant has no account yet, so the language is the
// one the form was shown in, and the copy goes through emailDictionary() so the
// org's product name reaches it.
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

// The answer to a declined partner application (#3362): the reason's sentence
// only — an admin's own note never leaves the audit row.
export async function sendAffiliateApplicationRejectedEmail({
  to,
  firstName,
  reason,
  locale,
  orgId,
}: {
  to: string;
  firstName: string;
  reason: 'not_a_fit' | 'duplicate' | 'incomplete' | 'other';
  locale?: string | null;
  orgId: string;
}) {
  const brand = await emailBrand(orgId);
  const M = (await emailDictionary(isLocale(locale ?? undefined) ? (locale as Locale) : defaultLocale, orgId)).affiliateApplicationEmail;
  await sendEmail({
    to,
    orgId,
    // no-user-row: the applicant was never given an account — nothing to unsubscribe.
    category: 'affiliate-application-decision',
    locale,
    fromName: brand.name,
    subject: M.rejected.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(M.rejected.heading))}
        <p>${esc(M.greeting.replace('{name}', firstName))}</p>
        <p>${esc(M.rejected.body)}</p>
        <p>${esc(M.rejected.reasons[reason])}</p>
      </div>
    `,
  });
}
