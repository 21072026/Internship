import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * The post-mentorship access window (#854). `canAccessCv` used to ask only
 * "does a relation exist?", so a mentor kept reading a former mentee's CV
 * forever. Access now expires `POST_MENTORSHIP_ACCESS_MONTHS` (6) after the
 * relation is marked COMPLETED.
 */

const PASSWORD = 'LifecyclePass123';

const mentorEmail = uniqueEmail('life-mentor');
const activeMenteeEmail = uniqueEmail('life-active');
const staleMenteeEmail = uniqueEmail('life-stale');
const recentMenteeEmail = uniqueEmail('life-recent');

let activeId = '';
let staleId = '';
let recentId = '';

function monthsAgo(months: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

test.beforeAll(async () => {
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Lifecycle Mentor');
  const [a, s, r] = await Promise.all([
    seedUser(activeMenteeEmail, 'x', 'MENTEE', 'Active Mentee'),
    seedUser(staleMenteeEmail, 'x', 'MENTEE', 'Stale Mentee'),
    seedUser(recentMenteeEmail, 'x', 'MENTEE', 'Recent Mentee'),
  ]);
  activeId = a.id;
  staleId = s.id;
  recentId = r.id;

  await Promise.all([
    prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: a.id, status: 'ACTIVE' } }),
    // Completed well outside the 6-month window.
    prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: s.id, status: 'COMPLETED', completedAt: monthsAgo(9) },
    }),
    // Completed inside it.
    prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: r.id, status: 'COMPLETED', completedAt: monthsAgo(1) },
    }),
  ]);

  await prisma.cvFile.createMany({
    data: [a.id, s.id, r.id].map((userId) => ({
      userId,
      filename: 'cv.pdf',
      contentType: 'application/pdf',
      size: 3,
      data: Buffer.from('pdf'),
    })),
  });
});

test.afterAll(async () => {
  await prisma.cvFile.deleteMany({ where: { userId: { in: [activeId, staleId, recentId] } } });
  for (const email of [mentorEmail, activeMenteeEmail, staleMenteeEmail, recentMenteeEmail]) {
    await cleanupByEmail(email);
  }
  await prisma.$disconnect();
});

test('a mentor loses CV access once the mentorship has been over for the window', { tag: '@smoke' }, async ({ page }) => {
  await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');

  // Active mentorship — unchanged behaviour.
  expect((await page.request.get(`/api/cv/${activeId}`)).status()).toBe(200);
  // Completed one month ago — still inside the 6-month reference window.
  expect((await page.request.get(`/api/cv/${recentId}`)).status()).toBe(200);
  // Completed nine months ago — access has expired.
  expect((await page.request.get(`/api/cv/${staleId}`)).status()).toBe(403);
});
