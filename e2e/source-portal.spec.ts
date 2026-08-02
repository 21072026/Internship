import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a source user can log in and submit mentees that show up for the admin', async ({ page }) => {
  const adminEmail = uniqueEmail('sp-admin');
  const sourceUserEmail = uniqueEmail('sp-source');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'SP Admin');
  const sourceUser = await seedUser(sourceUserEmail, 'SourcePass123', 'SOURCE', 'Fair Rep');
  const source = await prisma.source.create({ data: { name: `Fair ${Date.now()}` } });
  await prisma.user.update({ where: { id: sourceUser.id }, data: { sourceId: source.id } });
  const menteeEmail = uniqueEmail('sp-mentee');

  try {
    // Source signs in and lands on the source portal.
    await signInAsFreshUser(page, sourceUserEmail, 'SourcePass123', '/source');

    // Submit a mentee.
    const res = await page.request.post('/api/source/mentees', {
      data: { fullName: 'Sourced Mentee', email: menteeEmail, university: 'TU', skills: 'React, SQL' },
    });
    expect(res.status()).toBe(201);

    // It appears in the source's own list (pending, unassigned).
    const list = await (await page.request.get('/api/source/mentees')).json();
    const mine = list.mentees.find((m: { email: string }) => m.email === menteeEmail.toLowerCase());
    expect(mine).toBeTruthy();
    expect(mine.assigned).toBe(false);

    // The mentee exists as a MENTEE tagged with this source (visible to admin filters).
    const mentee = await prisma.user.findUnique({ where: { email: menteeEmail.toLowerCase() } });
    expect(mentee?.role).toBe('MENTEE');
    expect(mentee?.sourceId).toBe(source.id);

    // Admin can filter candidates by this source and find the mentee.
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');
    const cands = await (await page.request.get(`/api/candidates?source=${source.id}`)).json();
    expect(cands.candidates.some((c: { id: string }) => c.id === mentee!.id)).toBeTruthy();
  } finally {
    await cleanupByEmail(menteeEmail);
    await prisma.user.updateMany({ where: { id: sourceUser.id }, data: { sourceId: null } });
    await prisma.source.deleteMany({ where: { id: source.id } });
    await cleanupByEmail(sourceUserEmail);
    await cleanupByEmail(adminEmail);
  }
});
