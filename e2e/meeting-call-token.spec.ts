import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1237 — the token behind the embedded call.
//
// CI has no JaaS credentials, so what can be asserted here is the contract
// around the signature rather than a signature: who may ask for a token at all,
// and that an unconfigured deployment says so in a way the panel can fall back
// on (409 + a code) instead of failing shut.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('only the meeting\'s own people may ask for a call token', async ({ page }) => {
  const mentorEmail = uniqueEmail('tok-mentor');
  const strangerEmail = uniqueEmail('tok-stranger');
  const mentor = await seedUser(mentorEmail, 'TokenPass123', 'MENTOR', 'Token Mentor');
  const mentee = await seedUser(uniqueEmail('tok-mentee'), 'x', 'MENTEE', 'Token Mentee');
  await seedUser(strangerEmail, 'TokenPass123', 'MENTOR', 'Token Stranger');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const meeting = await prisma.meeting.create({
    data: {
      relationId: rel.id,
      title: 'Token check',
      meetLink: 'https://meet.jit.si/InternshipCRM-tokencheck',
      rsvpToken: randomBytes(24).toString('hex'),
      createdById: mentor.id,
    },
  });

  try {
    // Anonymous: no session, no token.
    expect((await page.request.get(`/api/meetings/${meeting.id}/call-token`)).status()).toBe(401);

    // A signed-in user with nothing to do with this meeting gets 404, not 403:
    // "exists but not yours" and "does not exist" must be indistinguishable.
    await signInAndSettle(page, strangerEmail, 'TokenPass123', '/mentor');
    expect((await page.request.get(`/api/meetings/${meeting.id}/call-token`)).status()).toBe(404);
    await page.context().clearCookies();

    // The organizer is allowed through the access check — and then hits the
    // configuration gate, because this deployment has no JaaS tenant. The panel
    // reads that code and keeps offering the plain link.
    await signInAndSettle(page, mentorEmail, 'TokenPass123', '/mentor');
    const res = await page.request.get(`/api/meetings/${meeting.id}/call-token`);
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('not-configured');

    // A made-up id is a 404 for everyone.
    expect((await page.request.get('/api/meetings/does-not-exist/call-token')).status()).toBe(404);
  } finally {
    await prisma.meeting.deleteMany({ where: { id: meeting.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(strangerEmail);
  }
});
