// Server half of the offer letter (#1857): which template an org uses, the
// merge values for one offer, and the one render both the send-time snapshot
// and the draft preview go through. The rule itself (tags, rendering, PDF-safe
// text) is pure in src/lib/offerLetter.ts.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getDictionary } from '@/i18n/dictionaries';
import { formatMinorAmount } from '@/lib/money';
import { isLocale, type Locale } from '@/i18n/config';
import { formatDate } from '@/lib/relativeTime';
import { intlLocaleFor } from '@/lib/interviewRequests';
import { compensationLine, renderOfferLetter, type MergeValues } from '@/lib/offerLetter';
import { BUILT_IN_OFFER_LETTERS } from '@/lib/offerLetterTemplates';

type Db = Prisma.TransactionClient | typeof prisma;

/** The org's default template for a locale, else the built-in one. */
export async function effectiveOfferTemplate(
  orgId: string | null,
  locale: Locale,
  db: Db = prisma,
): Promise<{ bodyMarkdown: string; custom: boolean }> {
  if (orgId) {
    const row = await db.offerTemplate.findFirst({
      where: { orgId, locale, isDefault: true },
      orderBy: { updatedAt: 'desc' },
      select: { bodyMarkdown: true },
    });
    if (row) return { bodyMarkdown: row.bodyMarkdown, custom: true };
  }
  return { bodyMarkdown: BUILT_IN_OFFER_LETTERS[locale], custom: false };
}

/**
 * Render one offer's letter in its candidate's language. Used to FREEZE the
 * snapshot on send and to preview a draft; a sent offer is always read from
 * its snapshot, never re-rendered.
 */
export async function renderLetterForOffer(offerId: string, db: Db = prisma): Promise<{ markdown: string; locale: Locale }> {
  const offer = await db.offer.findUniqueOrThrow({
    where: { id: offerId },
    select: {
      orgId: true,
      position: true,
      startDate: true,
      expiresAt: true,
      compensationNote: true,
      currency: true,
      baseAmountMinor: true,
      basePeriod: true,
      signingBonusMinor: true,
      otherBonusMinor: true,
      equityNote: true,
      hoursPerWeek: true,
      contractType: true,
      company: { select: { name: true } },
      org: { select: { name: true } },
      relation: { select: { mentee: { select: { fullName: true, preferredLanguage: true } } } },
    },
  });
  const mentee = offer.relation.mentee;
  const locale: Locale = isLocale(mentee.preferredLanguage) ? mentee.preferredLanguage : 'en';
  const dateLocale = intlLocaleFor(locale);
  // Calendar dates, not instants: read in UTC so the day never shifts.
  const day = (d: Date | null) => (d ? formatDate(d, dateLocale, { month: 'long', timeZone: 'UTC' }) : '—');
  const programName = offer.org?.name ?? '';
  const values: MergeValues = {
    candidateName: mentee.fullName,
    position: offer.position,
    companyName: offer.company?.name ?? programName,
    startDate: day(offer.startDate),
    compensation: compensationLine(offer, getDictionary(locale).offers.compensation, (m, cur) => formatMinorAmount(m, cur, locale)),
    expiresAt: day(offer.expiresAt),
    programName,
  };
  const template = await effectiveOfferTemplate(offer.orgId, locale, db);
  return { markdown: renderOfferLetter(template.bodyMarkdown, values), locale };
}
