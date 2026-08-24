import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// #1188: mentor capacity is BINDING on the public application link, and every
// application waits for the mentor's accept/decline. Capacity counts active
// relations PLUS pending applications; acceptingMentees=false closes the link
// outright; a null capacity keeps the link open (existing mentors unbroken).
const PASSWORD = 'CapMentor123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a full mentor link refuses applications and says so before the form', async ({ page, request }) => {
  const mentorEmail = uniqueEmail('cap-mentor');
  const menteeEmail = uniqueEmail('cap-existing');
  const applicantEmail = uniqueEmail('cap-applicant');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Cap Mentor');
  const existing = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Cap Existing');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 1 } });
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: existing.id } });

  try {
    // API: refused with a clear reason, no account created.
    const res = await request.post('/api/apply', {
      data: { mentorId: mentor.id, fullName: 'Cap Applicant', email: applicantEmail },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('mentor_full');
    expect(await prisma.user.findUnique({ where: { email: applicantEmail } })).toBeNull();

    // Public page: the explanation, never an empty form.
    await page.goto(`/apply/${mentor.id}`);
    await expect(page.getByTestId('apply-closed')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel('Full name')).toHaveCount(0);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(applicantEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('pending applications consume capacity: the second applicant to a capacity-1 mentor is refused', async ({ request }) => {
  const mentorEmail = uniqueEmail('cap1-mentor');
  const firstEmail = uniqueEmail('cap1-first');
  const secondEmail = uniqueEmail('cap1-second');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'CapOne Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 1 } });

  try {
    const first = await request.post('/api/apply', {
      data: { mentorId: mentor.id, fullName: 'First Applicant', email: firstEmail },
    });
    expect(first.ok()).toBeTruthy();

    const second = await request.post('/api/apply', {
      data: { mentorId: mentor.id, fullName: 'Second Applicant', email: secondEmail },
    });
    expect(second.status()).toBe(409);
    expect((await second.json()).code).toBe('mentor_full');
  } finally {
    await cleanupByEmail(secondEmail);
    await cleanupByEmail(firstEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('acceptingMentees=false closes the link regardless of capacity headroom', async ({ request }) => {
  const mentorEmail = uniqueEmail('paused-mentor');
  const applicantEmail = uniqueEmail('paused-applicant');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Paused Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { acceptingMentees: false } });

  try {
    const info = await request.get(`/api/apply?mentorId=${mentor.id}`);
    expect((await info.json()).accepting).toBe(false);
    const res = await request.post('/api/apply', {
      data: { mentorId: mentor.id, fullName: 'Paused Applicant', email: applicantEmail },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('mentor_not_accepting');
  } finally {
    await cleanupByEmail(applicantEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('mentor accepts an application: relation starts, applicant notified; decline notifies politely', async ({ page, request }) => {
  const mentorEmail = uniqueEmail('decide-mentor');
  const acceptEmail = uniqueEmail('decide-accept');
  const rejectEmail = uniqueEmail('decide-reject');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Decide Mentor');

  try {
    for (const [name, email] of [['Accept Applicant', acceptEmail], ['Reject Applicant', rejectEmail]] as const) {
      const res = await request.post('/api/apply', { data: { mentorId: mentor.id, fullName: name, email } });
      expect(res.ok()).toBeTruthy();
    }
    const acceptUser = await prisma.user.findUniqueOrThrow({ where: { email: acceptEmail } });
    const rejectUser = await prisma.user.findUniqueOrThrow({ where: { email: rejectEmail } });

    // Mentor signs in and decides from the applications inbox.
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
    await page.goto('/mentor/applications');

    const acceptReq = await prisma.mentorshipRequest.findFirstOrThrow({ where: { menteeId: acceptUser.id } });
    const rejectReq = await prisma.mentorshipRequest.findFirstOrThrow({ where: { menteeId: rejectUser.id } });

    await page.getByTestId(`application-accept-${acceptReq.id}`).click();
    await expect
      .poll(async () => (await prisma.mentorshipRequest.findUniqueOrThrow({ where: { id: acceptReq.id } })).status)
      .toBe('APPROVED');
    const rel = await prisma.mentorshipRelation.findFirst({ where: { mentorId: mentor.id, menteeId: acceptUser.id, status: 'ACTIVE' } });
    expect(rel).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: acceptUser.id, type: 'mentorship_request.approved' } })).toBe(1);
    // No echo: the deciding mentor gets no "mentee assigned to you" note about themself.
    expect(await prisma.notification.count({ where: { userId: mentor.id, type: 'mentorship_request.menteeAssigned' } })).toBe(0);

    await page.getByTestId(`application-reject-${rejectReq.id}`).click();
    await expect
      .poll(async () => (await prisma.mentorshipRequest.findUniqueOrThrow({ where: { id: rejectReq.id } })).status)
      .toBe('REJECTED');
    expect(await prisma.notification.count({ where: { userId: rejectUser.id, type: 'mentorship_request.rejected' } })).toBe(1);
    expect(await prisma.mentorshipRelation.findFirst({ where: { menteeId: rejectUser.id } })).toBeNull();

    // Server-side authorization: another mentor cannot decide requests that
    // don't name them — same shape as not-found.
    const otherMentorEmail = uniqueEmail('other-mentor');
    await seedUser(otherMentorEmail, PASSWORD, 'MENTOR', 'Other Mentor');
    try {
      const foreign = await prisma.mentorshipRequest.create({ data: { menteeId: rejectUser.id, preferredMentorId: mentor.id } });
      // Switching mentors mid-test needs the fresh-user guards: a blanket
      // clearCookies() lets /api/auth/session re-issue the previous session, so
      // /auth/signin redirects away mid-fill and the submit click resolves
      // against the old dashboard (documented in helpers/auth.ts). This is what
      // made the spec fail in the 2026-08-23 21:18 scheduled run.
      await signInAsFreshUser(page, otherMentorEmail, PASSWORD, '/mentor');
      const attack = await page.request.put('/api/mentor/applications', {
        data: { requestId: foreign.id, action: 'accept' },
      });
      expect(attack.status()).toBe(404);
      await prisma.mentorshipRequest.delete({ where: { id: foreign.id } });
    } finally {
      await cleanupByEmail(otherMentorEmail);
    }
  } finally {
    await prisma.notification.deleteMany({ where: { userId: mentor.id } });
    await cleanupByEmail(acceptEmail);
    await cleanupByEmail(rejectEmail);
    await cleanupByEmail(mentorEmail);
  }
});
