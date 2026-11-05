import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { notifyEvent } from '@/lib/notifications/router';
import { notifyOfferSent, notifyOfferDecided } from '@/lib/offerNotify';

/**
 * Hiring events reach exactly the people entitled to them (#1944).
 *
 * Who may receive each hiring event is declared ONCE, as the catalogue entry's
 * `audience` (src/lib/notifications/catalog.ts), and the router enforces it: a
 * recipient whose role is not listed is recorded SKIPPED `audience` on every
 * channel and gets no row. The first test is that guard, asserted against the
 * router itself — whatever a call site passes, the candidate never reads the
 * company's decline reason. The second walks an offer from sent to accepted
 * through the real send path and reads who was told.
 *
 * Same shape as e2e/notification-router.spec.ts: no browser, the ledger and the
 * bell rows are the observable.
 */

const PW = 'HiringNotify123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedWorld(prefix: string) {
  const org = await prisma.organization.create({ data: { name: `Hiring Notify ${prefix} ${Date.now()}`, slug: `hn-${prefix}-${Date.now()}-${Math.round(Math.random() * 1e4)}` } });
  const emails = {
    admin: uniqueEmail(`${prefix}-admin`),
    mentor: uniqueEmail(`${prefix}-mentor`),
    mentee: uniqueEmail(`${prefix}-mentee`),
    owner: uniqueEmail(`${prefix}-owner`),
    interviewer: uniqueEmail(`${prefix}-interviewer`),
  };
  const company = await prisma.company.create({ data: { name: `Acme Hiring ${prefix} ${Date.now()}`, orgId: org.id } });
  const admin = await seedUser(emails.admin, PW, 'ADMIN', 'Hiring Admin', org.id);
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'Hiring Mentor', org.id);
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', 'Hiring Candidate', org.id);
  const owner = await seedUser(emails.owner, PW, 'COMPANY', 'Hiring Owner', org.id);
  const interviewer = await seedUser(emails.interviewer, PW, 'COMPANY', 'Hiring Interviewer', org.id);
  await prisma.user.updateMany({ where: { id: { in: [owner.id, interviewer.id] } }, data: { companyId: company.id } });
  // The owner has no membership row (the implicit OWNER); the interviewer is an
  // INTERVIEWER seat on no panel about this candidate.
  await prisma.companyMembership.create({ data: { orgId: org.id, companyId: company.id, userId: interviewer.id, seatRole: 'INTERVIEWER' } });
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id, orgId: org.id } });
  const requisition = await prisma.requisition.create({ data: { orgId: org.id, companyId: company.id, title: 'Backend Intern', status: 'OPEN', openings: 2, requiredSkills: [] } });
  const users = { admin, mentor, mentee, owner, interviewer };
  const ids = Object.values(users).map((u) => u.id);
  return {
    org,
    company,
    relation,
    requisition,
    users,
    cleanup: async () => {
      await prisma.notificationDelivery.deleteMany({ where: { userId: { in: ids } } });
      await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await prisma.job.deleteMany({ where: { name: { in: ['notification.email', 'notification.deferred'] }, idempotencyKey: { contains: 'offer-' } } });
      await prisma.offer.deleteMany({ where: { relationId: relation.id } });
      await prisma.requisition.deleteMany({ where: { orgId: org.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
      await prisma.companyMembership.deleteMany({ where: { companyId: company.id } });
      for (const email of Object.values(emails)) await cleanupByEmail(email);
      await prisma.company.deleteMany({ where: { id: company.id } });
      await prisma.organization.deleteMany({ where: { id: org.id } });
    },
  };
}

const typesFor = async (userId: string) =>
  (await prisma.notification.findMany({ where: { userId }, select: { type: true } })).map((n) => n.type).sort();

test('a hiring event outside its audience is skipped, never delivered (#1944)', { tag: '@smoke' }, async () => {
  const w = await seedWorld('aud');
  try {
    const { mentee, owner, admin } = w.users;
    // A call site that (wrongly) hands the candidate the company's decline.
    const result = await notifyEvent([mentee.id, owner.id], 'interview_request.declined', { reasonCode: 'CANDIDATE_NOT_READY', requisitionId: w.requisition.id }, { orgId: w.org.id });
    expect(result.sent).toBe(1);

    expect(await typesFor(mentee.id)).toEqual([]);
    const skipped = await prisma.notificationDelivery.findMany({ where: { userId: mentee.id }, select: { status: true, skipReason: true } });
    expect(skipped.length).toBeGreaterThan(0);
    for (const row of skipped) expect(row).toEqual({ status: 'SKIPPED', skipReason: 'audience' });

    const told = await prisma.notification.findFirstOrThrow({ where: { userId: owner.id, type: 'interview_request.declined' }, select: { link: true } });
    // The company's card opens the role's applicant board.
    expect(told.link).toBe(`/company/requisitions/${w.requisition.id}`);

    // The mentor approval queue is never an admin-less candidate's either.
    await notifyEvent([mentee.id, admin.id], 'interview_request.received', { menteeName: 'Hiring Candidate' }, { orgId: w.org.id, channels: ['inApp'] });
    expect(await typesFor(mentee.id)).toEqual([]);
    expect(await typesFor(admin.id)).toEqual(['interview_request.received']);
  } finally {
    await w.cleanup();
  }
});

test('an offer reaches the candidate and their mentor when sent, the admin and the entitled company seats when decided (#1944)', async () => {
  const w = await seedWorld('offer');
  try {
    const { admin, mentor, mentee, owner, interviewer } = w.users;
    const offer = await prisma.offer.create({
      data: { orgId: w.org.id, relationId: w.relation.id, companyId: w.company.id, requisitionId: w.requisition.id, position: 'Backend Intern', status: 'SENT', sentAt: new Date(), createdById: admin.id },
    });

    await notifyOfferSent(offer.id);
    expect(await typesFor(mentee.id)).toEqual(['offer_sent.new']);
    expect(await typesFor(mentor.id)).toEqual(['offer_sent.mentor']);
    expect(await typesFor(owner.id)).toEqual([]);
    // The offer letter still goes out — now as the router's e-mail job, with
    // the body the call site rendered (sealed), not the catalogue template.
    const mail = await prisma.notificationDelivery.findFirstOrThrow({ where: { userId: mentee.id, eventKey: 'offer_sent.new', channel: 'email' }, select: { status: true } });
    expect(['QUEUED', 'SENT']).toContain(mail.status);

    // A repeated call (a retried request) tells nobody twice.
    await notifyOfferSent(offer.id);
    expect(await typesFor(mentee.id)).toEqual(['offer_sent.new']);

    await prisma.offer.update({ where: { id: offer.id }, data: { status: 'ACCEPTED', decidedAt: new Date() } });
    await notifyOfferDecided(offer.id, 'ACCEPTED');
    expect(await typesFor(admin.id)).toEqual(['offer_accepted.admin']);
    const adminRow = await prisma.notification.findFirstOrThrow({ where: { userId: admin.id, type: 'offer_accepted.admin' }, select: { link: true } });
    expect(adminRow.link).toBe(`/admin/candidates/${mentee.id}`);
    expect(await typesFor(owner.id)).toEqual(['offer_accepted.company']);
    // An INTERVIEWER seat off this candidate's panels may not see them, so the
    // card that names them never reaches it.
    expect(await typesFor(interviewer.id)).toEqual([]);
    // Nothing internal reached the candidate or the mentor.
    expect(await typesFor(mentee.id)).toEqual(['offer_sent.new']);
    expect(await typesFor(mentor.id)).toEqual(['offer_sent.mentor']);

    // Once the interviewer sits on a panel about this candidate, they may.
    const panel = await prisma.interviewPanel.create({ data: { orgId: w.org.id, subjectId: mentee.id, createdById: admin.id } });
    await prisma.interviewPanelMember.create({ data: { panelId: panel.id, userId: interviewer.id } });
    const second = await prisma.offer.create({
      data: { orgId: w.org.id, relationId: w.relation.id, companyId: w.company.id, position: 'Backend Intern II', status: 'DECLINED', sentAt: new Date(), decidedAt: new Date(), createdById: admin.id },
    });
    await notifyOfferDecided(second.id, 'DECLINED');
    expect(await typesFor(interviewer.id)).toEqual(['offer_declined.company']);
    await prisma.interviewPanelMember.deleteMany({ where: { panelId: panel.id } });
    await prisma.interviewPanel.delete({ where: { id: panel.id } });
  } finally {
    await w.cleanup();
  }
});
