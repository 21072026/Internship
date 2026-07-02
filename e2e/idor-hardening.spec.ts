import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string, home: string) {
  await page.context().clearCookies();
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

// An outsider mentee must not reach another relation's goals / evaluations /
// messages, and must not write to them either (server-side authorization).
test('a non-participant cannot read or write another relation goals/evaluations/messages', async ({ page }) => {
  const mentorEmail = uniqueEmail('idor-mentor');
  const menteeEmail = uniqueEmail('idor-mentee');
  const outsiderEmail = uniqueEmail('idor-outsider');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Idor Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Idor Mentee');
  await seedUser(outsiderEmail, 'OutPass123', 'MENTEE', 'Idor Outsider');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signIn(page, outsiderEmail, 'OutPass123', '/portal');

    // Reads are forbidden.
    expect((await page.request.get(`/api/goals?relationId=${rel.id}`)).status()).toBe(403);
    expect((await page.request.get(`/api/evaluations?relationId=${rel.id}`)).status()).toBe(403);
    expect((await page.request.get(`/api/messages?relationId=${rel.id}`)).status()).toBe(403);

    // Writes are forbidden too.
    expect((await page.request.post('/api/goals', { data: { relationId: rel.id, title: 'x' } })).status()).toBe(403);
    expect((await page.request.post('/api/evaluations', { data: { relationId: rel.id, scores: { technical: 5 } } })).status()).toBe(403);
    expect((await page.request.post('/api/messages', { data: { relationId: rel.id, body: 'x' } })).status()).toBe(403);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(outsiderEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

// A SOURCE user must only ever see their own source's mentees, and only an
// admin may provision source/company logins or list all users.
test('source users are scoped to their own source; admin-only endpoints reject them', async ({ page }) => {
  const sourceUserEmail = uniqueEmail('idor-src');
  const sourceUser = await seedUser(sourceUserEmail, 'SrcPass123', 'SOURCE', 'Idor Source');
  const sourceA = await prisma.source.create({ data: { name: `A ${Date.now()}` } });
  const sourceB = await prisma.source.create({ data: { name: `B ${Date.now()}` } });
  await prisma.user.update({ where: { id: sourceUser.id }, data: { sourceId: sourceA.id } });
  // A mentee that belongs to a DIFFERENT source.
  const otherMentee = await seedUser(uniqueEmail('idor-bm'), 'x', 'MENTEE', 'Other Source Mentee');
  await prisma.user.update({ where: { id: otherMentee.id }, data: { sourceId: sourceB.id } });

  try {
    await signIn(page, sourceUserEmail, 'SrcPass123', '/source');

    // Source sees only its own (empty) list — not sourceB's mentee.
    const list = await (await page.request.get('/api/source/mentees')).json();
    expect(list.mentees.some((m: { id: string }) => m.id === otherMentee.id)).toBeFalsy();

    // Admin-only endpoints are forbidden for a SOURCE user.
    expect((await page.request.get('/api/users')).status()).toBe(401);
    expect((await page.request.post('/api/admin/source-users', { data: { sourceId: sourceB.id, email: 'z@z.com', fullName: 'Z' } })).status()).toBe(401);
  } finally {
    await prisma.user.updateMany({ where: { id: sourceUser.id }, data: { sourceId: null } });
    await cleanupByEmail(otherMentee.email);
    await prisma.source.deleteMany({ where: { id: { in: [sourceA.id, sourceB.id] } } });
    await cleanupByEmail(sourceUserEmail);
  }
});
