import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * The merged referrer field (#1296).
 *
 * "Who brought this person in" used to be two selects on two different cards of
 * the candidate screen — "Getiren kişi" (`referredById`) and "Kaynak"
 * (`sourceId`). This locks in the merge: one picker, mutually exclusive columns,
 * and a source that can be created without leaving the screen.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('one referrer field: pick a person, then create a source in place', { tag: '@smoke' }, async ({ page }) => {
  const adminEmail = uniqueEmail('ref-admin');
  const mentorEmail = uniqueEmail('ref-mentor');
  const menteeEmail = uniqueEmail('ref-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ref Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Ref Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Ref Mentee');
  const sourceUserEmail = uniqueEmail('ref-source-login');
  const newSourceName = `Gulizar Hanim ${Date.now()}`;
  let createdSourceId = '';

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    await page.goto(`/admin/candidates/${mentee.id}`);

    const picker = page.getByTestId('referrer-select');
    await expect(picker).toBeVisible({ timeout: 20_000 });
    // The old second select is gone — that is the point of the merge.
    await expect(page.getByTestId('referred-by-select')).toHaveCount(0);

    // A registered person as the referrer.
    await picker.selectOption(`user:${mentor.id}`);
    await expect
      .poll(async () => (await prisma.user.findUnique({ where: { id: mentee.id } }))?.referredById, { timeout: 15_000 })
      .toBe(mentor.id);

    // Now a source that does not exist yet, created from this very screen.
    await picker.selectOption('__new_source__');
    await page.getByTestId('referrer-new-source-name').fill(newSourceName);
    await page.getByTestId('referrer-new-source-save').click();

    await expect
      .poll(
        async () => {
          const row = await prisma.user.findUnique({
            where: { id: mentee.id },
            select: { sourceId: true, referredById: true },
          });
          return row ? `${row.sourceId ? 'source' : 'none'}/${row.referredById ?? 'null'}` : 'missing';
        },
        { timeout: 15_000 }
      )
      // Picking the other kind clears the first one: one referrer, never two.
      .toBe('source/null');

    const saved = await prisma.user.findUnique({
      where: { id: mentee.id },
      select: { sourceId: true, source: { select: { name: true } } },
    });
    createdSourceId = saved?.sourceId ?? '';
    expect(saved?.source?.name).toBe(newSourceName);

    // The invariant is the API's, not just the UI's.
    const both = await page.request.patch(`/api/users/${mentee.id}`, {
      data: { referredById: mentor.id, sourceId: createdSourceId },
    });
    expect(both.status()).toBe(400);

    // On a SOURCE login `sourceId` is which source that account speaks for, not
    // a referrer — the merged field must never clear it.
    const sourceUser = await prisma.user.create({
      data: {
        email: sourceUserEmail,
        password: '!source-no-login',
        role: 'SOURCE',
        fullName: 'Ref Source Login',
        skills: [],
        sourceId: createdSourceId,
      },
    });
    const patched = await page.request.patch(`/api/users/${sourceUser.id}`, {
      data: { referredById: mentor.id, sourceId: null },
    });
    expect(patched.ok()).toBeTruthy();
    const afterSourceWrite = await prisma.user.findUnique({
      where: { id: sourceUser.id },
      select: { sourceId: true, referredById: true },
    });
    expect(afterSourceWrite?.sourceId).toBe(createdSourceId);
    expect(afterSourceWrite?.referredById).toBe(mentor.id);
  } finally {
    await prisma.user.updateMany({ where: { email: sourceUserEmail }, data: { sourceId: null, referredById: null } });
    await cleanupByEmail(sourceUserEmail);
    await prisma.user.updateMany({ where: { id: mentee.id }, data: { sourceId: null, referredById: null } });
    if (createdSourceId) await prisma.source.deleteMany({ where: { id: createdSourceId } });
    await prisma.source.deleteMany({ where: { name: newSourceName } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
