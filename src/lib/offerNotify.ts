// Notification + email side-effects for offer transitions (#809). Shared
// between the offers API route and the expiry cron so both send exactly the
// same notifications for a given transition.
//
// EVERYTHING THROUGH THE ROUTER (#1944). Each party hears its own catalogue
// event, and WHO may hear it is that entry's `audience`, not this file:
//   sent    → the mentee (`offer_sent.new`, with the offer mail) and their
//             active mentor (`offer_sent.mentor`);
//   decided → the admin who made the offer (`offer_<outcome>.admin`, with the
//             decision mail) and the offering company's seats that may see the
//             candidate (`offer_<outcome>.company`).
// The mails are rendered here and handed over as they are (`email`), so the
// router's preference, quiet-hour and ledger rules apply without a word of the
// copy changing — and the channels are no longer pinned, so chat rides along
// for anybody with a confirmed chat identity.

import { prisma } from '@/lib/prisma';
import { raiseOfferEvent } from '@/lib/offerEvents';
import { notifyEvent } from '@/lib/notifications/router';
import { companyUsersWhoMaySee } from '@/lib/companySeatGate';
import { renderOfferSentEmail, renderOfferDecisionEmail } from '@/services/emailService';

// SENT — the mentee must act; their mentor should know it is out.
export async function notifyOfferSent(offerId: string): Promise<void> {
  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      position: true,
      startDate: true,
      expiresAt: true,
      relation: {
        select: {
          id: true,
          orgId: true,
          mentorId: true,
          status: true,
          mentee: { select: { id: true, fullName: true, preferredLanguage: true } },
        },
      },
      company: { select: { name: true } },
    },
  });
  if (!offer) return;
  const { relation } = offer;
  const mentee = relation.mentee;
  const email = await renderOfferSentEmail({
    fullName: mentee.fullName,
    position: offer.position,
    companyName: offer.company?.name ?? null,
    startDate: offer.startDate,
    expiresAt: offer.expiresAt,
    locale: mentee.preferredLanguage,
    orgId: relation.orgId,
    // The mentee is the one being made the offer, so they are the recipient.
    userId: mentee.id,
  });
  await notifyEvent(mentee.id, 'offer_sent.new', { position: offer.position }, { dedupeKey: `offer-sent:${offer.id}`, orgId: relation.orgId, email });
  if (relation.mentorId && relation.status === 'ACTIVE') {
    await notifyEvent(
      relation.mentorId,
      'offer_sent.mentor',
      { menteeName: mentee.fullName, position: offer.position, relationId: relation.id },
      { dedupeKey: `offer-sent:${offer.id}`, orgId: relation.orgId }
    );
  }
}

const ADMIN_EVENT = { ACCEPTED: 'offer_accepted.admin', DECLINED: 'offer_declined.admin', EXPIRED: 'offer_expired.admin' } as const;
const COMPANY_EVENT = { ACCEPTED: 'offer_accepted.company', DECLINED: 'offer_declined.company', EXPIRED: 'offer_expired.company' } as const;

// ACCEPTED / DECLINED / EXPIRED — the admin who created the offer acts on it
// next; the offering company learns the answer.
export async function notifyOfferDecided(offerId: string, outcome: 'ACCEPTED' | 'DECLINED' | 'EXPIRED'): Promise<void> {
  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      position: true,
      companyId: true,
      requisitionId: true,
      relation: { select: { orgId: true, mentee: { select: { id: true, fullName: true } } } },
      createdBy: { select: { id: true, fullName: true, preferredLanguage: true } },
    },
  });
  if (!offer) return;
  const orgId = offer.relation.orgId;
  const admin = offer.createdBy;
  const mentee = offer.relation.mentee;
  const dedupeKey = `offer-decided:${offer.id}`;
  const email = await renderOfferDecisionEmail({
    fullName: admin.fullName,
    menteeName: mentee.fullName,
    position: offer.position,
    outcome,
    locale: admin.preferredLanguage,
    orgId,
    // The offer's CREATOR is the recipient here — the mentee only decided it.
    // `offer.relation.mentee` is selected for the name in the body, which makes
    // mixing the two up easy and expensive.
    userId: admin.id,
  });
  await notifyEvent(admin.id, ADMIN_EVENT[outcome], { menteeName: mentee.fullName, position: offer.position, menteeId: mentee.id }, { dedupeKey, orgId, email });
  // The company names the candidate only to the seats that may already see
  // them (an INTERVIEWER off their panels may not, #1870).
  if (offer.companyId) {
    const seats = await companyUsersWhoMaySee(orgId, offer.companyId, mentee.id);
    if (seats.length > 0) {
      await notifyEvent(
        seats.map((s) => s.id),
        COMPANY_EVENT[outcome],
        { menteeName: mentee.fullName, position: offer.position, ...(offer.requisitionId ? { requisitionId: offer.requisitionId } : {}) },
        { dedupeKey, orgId }
      );
    }
  }
}

// Expire SENT offers whose expiresAt has passed (#809), for the scheduled cron.
//
// PLATFORM-WIDE ON PURPOSE. `Offer` is registered in TENANT_MODELS (#1559), but
// this runs from /api/cron, outside any request and therefore outside any tenant
// context — so the middleware does not scope it and the sweep sees every
// tenant's due offers. That is the required behaviour: one cron tick has to
// expire every org's offers, and there is no session to resolve an org from. The
// `updateMany` claim below is guarded by `status: 'SENT'`, not by a tenant, for
// the same reason.
// Idempotent the same way sendMeetingReminders() is: the status flip is
// claimed with a guarded `updateMany` (status: 'SENT' in the where) BEFORE any
// audit/notify/email — only the caller that wins the claim (count === 1) sends
// anything, so two overlapping cron ticks can never double-transition,
// double-audit or double-mail the same offer.
export async function expireOffers(): Promise<{ checked: number; expired: number }> {
  const now = new Date();
  const due = await prisma.offer.findMany({
    where: { status: 'SENT', expiresAt: { lt: now } },
    select: { id: true, orgId: true, requisitionId: true, relation: { select: { menteeId: true } } },
  });

  let expired = 0;
  for (const o of due) {
    const claim = await prisma.offer.updateMany({
      where: { id: o.id, status: 'SENT' },
      data: { status: 'EXPIRED', decidedAt: now },
    });
    if (claim.count === 0) continue;
    expired++;

    // A sweep binds no tenant scope, so the audit row's org is the offer's own
    // (#2012) — otherwise it would never reach that tenant's drain.
    await prisma.auditLog.create({ data: { actorId: 'system', action: 'offer.expire', targetId: o.id, orgId: o.orgId ?? null } });
    await notifyOfferDecided(o.id, 'EXPIRED');
    // The cron path is a writer too (#1998): without this an integrator would
    // see SENT offers that never end.
    await raiseOfferEvent('offer.expired', { id: o.id, orgId: o.orgId, requisitionId: o.requisitionId, menteeId: o.relation.menteeId }, { id: null, type: 'system' });
  }

  return { checked: due.length, expired };
}
