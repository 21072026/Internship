// Contact permission — the double opt-in of the demo form (#2569 → #2577).
// docs/contact-permission.md § Double opt-in.
//
// Split from src/lib/contactPermission.ts (the writer) so that the import CLI,
// which writes through that file, does not load the mail service.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { refuseConfirmation, type DoiRefusal } from '@/lib/contactPermissionRule';
import { revokeContactPermission, writeContactPermission } from '@/lib/contactPermission';
import { contactPermissionUrl, doiMailCapKey as capKey } from '@/lib/contactPermissionTokens';
import { sendContactPermissionConfirmationEmail } from '@/services/emailService';

export type DoiMailOutcome = 'sent' | 'capped' | 'failed';

/**
 * Send the confirmation mail for a ticked product-news box — at most ONE per
 * address per UTC day, whichever tenant's form asked (#2569 § 9). The cap is a
 * primary-key insert, so two concurrent submits cannot both pass it; the form's
 * own `company-inquiry` rate-limit bucket (3/hour per client IP) sits in front.
 * A capped request stays an unconfirmed REQUEST: nothing is lost that the
 * person cannot redo tomorrow, and nobody's inbox can be flooded through it.
 */
export async function sendDoiConfirmation(input: {
  inquiryId: string;
  orgId: string | null;
  email: string;
  contactName: string;
  companyName: string;
  locale: string | null;
  /** The origin the request arrived on — `requestOrigin()`, a served host. */
  origin: string;
  now?: Date;
}): Promise<DoiMailOutcome> {
  const now = input.now ?? new Date();
  const key = capKey(input.email, now);
  // Yesterday's keys can no longer block anything; sweep them here, cheaply.
  await prisma.contactConfirmationMailCap
    .deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) } } })
    .catch(() => {});
  try {
    await prisma.contactConfirmationMailCap.create({ data: { key } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'capped';
    throw e;
  }
  let delivered: Awaited<ReturnType<typeof sendContactPermissionConfirmationEmail>>;
  try {
    delivered = await sendContactPermissionConfirmationEmail({
      to: input.email,
      contactName: input.contactName,
      companyName: input.companyName,
      confirmUrl: contactPermissionUrl(input.origin, 'confirm', input.inquiryId),
      optOutUrl: contactPermissionUrl(input.origin, 'optout', input.inquiryId),
      locale: input.locale,
      orgId: input.orgId,
    });
  } catch (e) {
    delivered = 'FAILED';
    console.error('Contact permission confirmation mail failed:', e);
  }
  // "Did not throw" is not "was sent" (#1431): with SMTP unconfigured or in
  // demo mode sendEmail returns SKIPPED. Not sent, so not spent — give the
  // day's slot back — and not stamped: `marketingOptInMailSentAt` is evidence
  // that a confirmation mail went out, and must never say so falsely.
  if (delivered !== 'SENT') {
    await prisma.contactConfirmationMailCap.delete({ where: { key } }).catch(() => {});
    return 'failed';
  }
  await prisma.companyInquiry.updateMany({
    where: { id: input.inquiryId, orgId: input.orgId },
    data: { marketingOptInMailSentAt: now },
  });
  return 'sent';
}

const INQUIRY_EVIDENCE = {
  id: true,
  orgId: true,
  email: true,
  locale: true,
  createdAt: true,
  marketingOptInRequested: true,
  marketingOptInTextVersion: true,
  marketingOptInConfirmedAt: true,
  marketingOptOutAt: true,
  convertedCompanyId: true,
} as const;

export type ConfirmOutcome = { kind: 'confirmed' } | { kind: 'refused'; reason: DoiRefusal | 'not_found' };

/**
 * The address owner pressed "confirm" (POST from /contact-permission/confirm).
 * If the request is already an account, the account gets its DOI_CONFIRMED
 * permission now; otherwise the conversion carries it over later
 * (`applyInquiryPermission`).
 *
 * Only the press that CLAIMS the confirmation writes as `doi` — the writer that
 * may lift a revocation. A later press of the same link (a replay, weeks after
 * an admin revoked or the person objected through another enquiry's link) is
 * not a new consent: it answers `confirmed` again and carries the old evidence
 * over only as a conversion would (`inquiry` — never over a revoked row, never
 * over an equal or stronger basis), which is what repairs an account the first
 * press could not reach, and nothing more.
 */
export async function confirmDoi(inquiryId: string, now = new Date()): Promise<ConfirmOutcome> {
  const inquiry = await prisma.companyInquiry.findUnique({ where: { id: inquiryId }, select: INQUIRY_EVIDENCE });
  if (!inquiry) return { kind: 'refused', reason: 'not_found' };
  let claimedNow = false;
  if (!inquiry.marketingOptInConfirmedAt) {
    const refusal = refuseConfirmation(
      { requested: inquiry.marketingOptInRequested, optedOutAt: inquiry.marketingOptOutAt, createdAt: inquiry.createdAt },
      now,
    );
    if (refusal) return { kind: 'refused', reason: refusal };
    const claimed = await prisma.companyInquiry.updateMany({
      where: { id: inquiry.id, marketingOptInConfirmedAt: null, marketingOptOutAt: null },
      data: { marketingOptInConfirmedAt: now },
    });
    if (claimed.count === 1) {
      claimedNow = true;
      inquiry.marketingOptInConfirmedAt = now;
      await logActivity({
        action: 'contact_permission.doi_confirmed',
        targetType: 'company_inquiry',
        targetId: inquiry.id,
        detail: `text=${inquiry.marketingOptInTextVersion ?? '?'}`,
      });
    } else {
      const again = await prisma.companyInquiry.findUnique({ where: { id: inquiry.id }, select: INQUIRY_EVIDENCE });
      if (!again?.marketingOptInConfirmedAt) return { kind: 'refused', reason: 'opted_out' };
      Object.assign(inquiry, again);
    }
  } else if (inquiry.marketingOptOutAt) {
    return { kind: 'refused', reason: 'opted_out' };
  }
  if (inquiry.convertedCompanyId) {
    await writeInquiryEvidence(claimedNow ? 'doi' : 'inquiry', inquiry, inquiry.convertedCompanyId);
  }
  return { kind: 'confirmed' };
}

/**
 * "No, and do not write to me" (POST from /contact-permission/opt-out). Never
 * expires, idempotent, and answers the same whether or not the enquiry exists
 * — the caller only learns that the link was valid.
 */
export async function optOutDoi(inquiryId: string, now = new Date()): Promise<void> {
  const inquiry = await prisma.companyInquiry.findUnique({ where: { id: inquiryId }, select: INQUIRY_EVIDENCE });
  if (!inquiry) return;
  const claimed = await prisma.companyInquiry.updateMany({
    where: { id: inquiry.id, marketingOptOutAt: null },
    data: { marketingOptOutAt: now },
  });
  if (claimed.count === 1) {
    await logActivity({
      action: 'contact_permission.opted_out',
      targetType: 'company_inquiry',
      targetId: inquiry.id,
      detail: 'via link',
    });
  }
  if (inquiry.convertedCompanyId) {
    await revokeContactPermission({
      orgId: inquiry.orgId,
      companyId: inquiry.convertedCompanyId,
      channel: 'EMAIL',
      via: 'LINK',
      address: inquiry.email,
      inquiryId: inquiry.id,
      now,
    });
  }
}

/**
 * An enquiry just became an account (src/lib/inquiryLead.ts): carry what the
 * enquiry proves over to the account — a confirmed opt-in as DOI_CONFIRMED, an
 * opt-out as a revocation, and otherwise INQUIRY_REPLY (we may answer their
 * request; that is not advertising permission).
 */
export async function applyInquiryPermission(input: { inquiryId: string; orgId: string; companyId: string }): Promise<void> {
  const inquiry = await prisma.companyInquiry.findFirst({
    where: { id: input.inquiryId, orgId: input.orgId },
    select: INQUIRY_EVIDENCE,
  });
  if (!inquiry) return;
  if (inquiry.marketingOptOutAt) {
    await revokeContactPermission({
      orgId: input.orgId,
      companyId: input.companyId,
      channel: 'EMAIL',
      via: 'LINK',
      address: inquiry.email,
      inquiryId: inquiry.id,
      now: inquiry.marketingOptOutAt,
    });
    return;
  }
  await writeInquiryEvidence('inquiry', inquiry, input.companyId);
}

async function writeInquiryEvidence(
  writer: 'doi' | 'inquiry',
  inquiry: {
    id: string;
    orgId: string | null;
    email: string;
    locale: string | null;
    createdAt: Date;
    marketingOptInRequested: boolean | null;
    marketingOptInTextVersion: string | null;
    marketingOptInConfirmedAt: Date | null;
  },
  companyId: string,
): Promise<void> {
  const confirmed = !!inquiry.marketingOptInConfirmedAt;
  const changed = await writeContactPermission({
    writer,
    orgId: inquiry.orgId,
    companyId,
    channel: 'EMAIL',
    basis: confirmed ? 'DOI_CONFIRMED' : 'INQUIRY_REPLY',
    address: inquiry.email,
    textVersion: confirmed ? inquiry.marketingOptInTextVersion : null,
    textLocale: confirmed ? inquiry.locale : null,
    requestedAt: inquiry.marketingOptInRequested ? inquiry.createdAt : null,
    confirmedAt: inquiry.marketingOptInConfirmedAt,
    inquiryId: inquiry.id,
  });
  if (changed) {
    await logActivity({
      action: 'contact_permission.recorded',
      targetType: 'Company',
      targetId: companyId,
      detail: `channel=EMAIL basis=${confirmed ? 'DOI_CONFIRMED' : 'INQUIRY_REPLY'} inquiry=${inquiry.id}`,
    });
  }
}

