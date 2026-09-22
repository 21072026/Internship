import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can bulk-deactivate and bulk-reactivate selected candidates', async ({ page }) => {
  const adminEmail = uniqueEmail('bulk-admin');
  const menteeAEmail = uniqueEmail('bulk-mentee-a');
  const menteeBEmail = uniqueEmail('bulk-mentee-b');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Bulk Admin');
  const menteeA = await seedUser(menteeAEmail, 'x', 'MENTEE', 'Bulk Candidate A');
  const menteeB = await seedUser(menteeBEmail, 'x', 'MENTEE', 'Bulk Candidate B');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/candidates');
    // Every candidate is rendered twice — md:hidden mobile list + desktop grid —
    // so name locators have to be scoped to one list to stay strict-mode safe.
    const desktopList = page.getByTestId('candidates-desktop-list');
    await expect(desktopList.getByText('Bulk Candidate A')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId(`candidate-card-${menteeA.id}`).getByRole('checkbox').check();
    await page.getByTestId(`candidate-card-${menteeB.id}`).getByRole('checkbox').check();

    await expect(page.getByText('2 selected')).toBeVisible();
    await page.getByRole('button', { name: /^Deactivate$/i }).click();

    await expect(async () => {
      const a = await prisma.user.findUnique({ where: { id: menteeA.id } });
      const b = await prisma.user.findUnique({ where: { id: menteeB.id } });
      expect(a?.isActive).toBe(false);
      expect(b?.isActive).toBe(false);
    }).toPass({ timeout: 10_000 });

    // Deactivated candidates leave the default (active) view and move to the
    // Archive tab.
    await expect(desktopList.getByText('Bulk Candidate A')).toHaveCount(0);
    await page.getByTestId('candidates-tab-archived').click();
    await expect(page.getByTestId(`candidate-card-${menteeA.id}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Inactive').first()).toBeVisible();

    // Reactivate one of them via the API directly (already exercised the UI path above).
    const bulkRes = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [menteeA.id], action: 'activate' },
    });
    expect(bulkRes.ok()).toBeTruthy();
    const afterReactivate = await prisma.user.findUnique({ where: { id: menteeA.id } });
    expect(afterReactivate?.isActive).toBe(true);

    // Safety: the endpoint never touches a non-MENTEE account even if targeted.
    const adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });
    const guardRes = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [adminUser!.id], action: 'deactivate' },
    });
    const guardBody = await guardRes.json();
    expect(guardBody.updated).toBe(0);
    const adminAfter = await prisma.user.findUnique({ where: { id: adminUser!.id } });
    expect(adminAfter?.isActive).toBe(true);
  } finally {
    await cleanupByEmail(menteeAEmail);
    await cleanupByEmail(menteeBEmail);
    await cleanupByEmail(adminEmail);
  }
});

/**
 * Bulk owner assignment (#2439).
 *
 * The point of the assertions below is NOT that a column changed. "Owner" in
 * this repo is `MentorshipRelation.mentorId`, and changing it is the transfer
 * rule (#2289, docs/mentor-transfer.md): a pairing with no history may be
 * re-pointed in place, one that carries work must be closed and chained,
 * because interaction logs are attributed through the relation's mentor and a
 * plain `updateMany` would hand one mentor's meetings to another — a hundred
 * at a time. So the same batch is seeded with both shapes, and each is checked
 * for the outcome the rule demands.
 */
test('bulk owner assignment follows the transfer rule per row and reports what actually moved', async ({ page }) => {
  const pw = 'BulkOwnerPass123';
  const adminEmail = uniqueEmail('bo-admin');
  const oldOwnerEmail = uniqueEmail('bo-old');
  const newOwnerEmail = uniqueEmail('bo-new');
  const freshEmail = uniqueEmail('bo-fresh');
  const workedEmail = uniqueEmail('bo-worked');
  const looseEmail = uniqueEmail('bo-loose');

  await seedUser(adminEmail, pw, 'ADMIN', 'Bulk Owner Admin');
  const oldOwner = await seedUser(oldOwnerEmail, 'x', 'MENTOR', 'Bulk Old Owner');
  const newOwner = await seedUser(newOwnerEmail, 'x', 'MENTOR', 'Bulk New Owner');
  const fresh = await seedUser(freshEmail, 'x', 'MENTEE', 'Bulk Fresh Mentee');
  const worked = await seedUser(workedEmail, 'x', 'MENTEE', 'Bulk Worked Mentee');
  // Selected, but owned by nobody: there is no live pairing to re-point, and a
  // checkbox in a grid must not quietly create a mentorship.
  const loose = await seedUser(looseEmail, 'x', 'MENTEE', 'Bulk Loose Mentee');

  const freshRel = await prisma.mentorshipRelation.create({
    data: { mentorId: oldOwner.id, menteeId: fresh.id },
  });
  const workedRel = await prisma.mentorshipRelation.create({
    data: { mentorId: oldOwner.id, menteeId: worked.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  await prisma.interactionLog.create({
    data: { relationId: workedRel.id, date: new Date(), notes: 'Kick-off call', type: 'Meeting' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // The action needs a destination, and says which field is missing.
    const noOwner = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [fresh.id], action: 'assignOwner' },
    });
    expect(noOwner.status()).toBe(400);
    expect((await noOwner.json()).code).toBe('owner_required');

    const res = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [fresh.id, worked.id, loose.id], action: 'assignOwner', ownerId: newOwner.id },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Three were selected, two had an owner to change.
    expect(body.updated).toBe(2);
    expect(body.skipped).toBe(1);

    // No history → corrected in place: one row, still ACTIVE, never "completed".
    const freshRows = await prisma.mentorshipRelation.findMany({ where: { menteeId: fresh.id } });
    expect(freshRows).toHaveLength(1);
    expect(freshRows[0].id).toBe(freshRel.id);
    expect(freshRows[0].mentorId).toBe(newOwner.id);
    expect(freshRows[0].status).toBe('ACTIVE');
    expect(freshRows[0].lifecycleState).toBeNull();

    // History → handed over: the old pairing closes as a reassignment and keeps
    // its interaction, the successor carries the stage and points back at it.
    const workedRows = await prisma.mentorshipRelation.findMany({ where: { menteeId: worked.id } });
    expect(workedRows).toHaveLength(2);
    const closed = workedRows.find((r) => r.id === workedRel.id)!;
    expect(closed.status).toBe('COMPLETED');
    expect(closed.lifecycleState).toBe('ENDED_REASSIGNED');
    expect(closed.endReasonCode).toBe('mentor_unavailable');
    expect(closed.mentorId).toBe(oldOwner.id);
    const successor = workedRows.find((r) => r.id !== workedRel.id)!;
    expect(successor.mentorId).toBe(newOwner.id);
    expect(successor.status).toBe('ACTIVE');
    expect(successor.previousRelationId).toBe(workedRel.id);
    expect(successor.pipelineStatus).toBe('INTERNSHIP_IN_PROGRESS_450');

    // The invariant the whole operation exists to keep: exactly one live mentor.
    for (const menteeId of [fresh.id, worked.id]) {
      const live = await prisma.mentorshipRelation.count({ where: { menteeId, status: 'ACTIVE' } });
      expect(live).toBe(1);
    }
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: loose.id } })).toBe(0);

    // Running it again changes nothing: everybody is already on this owner, so
    // the report says zero rather than counting them a second time.
    const again = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [fresh.id, worked.id, loose.id], action: 'assignOwner', ownerId: newOwner.id },
    });
    expect((await again.json()).updated).toBe(0);
  } finally {
    await prisma.mentorshipRelation.deleteMany({
      where: { menteeId: { in: [fresh.id, worked.id, loose.id] } },
    });
    await cleanupByEmail(freshEmail);
    await cleanupByEmail(workedEmail);
    await cleanupByEmail(looseEmail);
    await cleanupByEmail(oldOwnerEmail);
    await cleanupByEmail(newOwnerEmail);
    await cleanupByEmail(adminEmail);
  }
});

/**
 * "My candidates" (#2438) — the quick filter, and the two things that make it
 * usable rather than decorative: it COMPOSES with the other filters instead of
 * replacing them, and it lives in the URL so the view can be pasted to a
 * colleague.
 */
test('the "my candidates" filter composes with search, rides in the URL, and follows a bulk owner change', async ({ page }) => {
  const pw = 'MinePass123';
  const adminEmail = uniqueEmail('mine-admin');
  const otherOwnerEmail = uniqueEmail('mine-other');
  const ownMenteeEmail = uniqueEmail('mine-own');
  const theirMenteeEmail = uniqueEmail('mine-their');

  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Mine Filter Admin');
  const otherOwner = await seedUser(otherOwnerEmail, 'x', 'MENTOR', 'Mine Other Owner');
  const ownMentee = await seedUser(ownMenteeEmail, 'x', 'MENTEE', 'Minefilter Own Mentee');
  const theirMentee = await seedUser(theirMenteeEmail, 'x', 'MENTEE', 'Minefilter Their Mentee');

  await prisma.mentorshipRelation.create({ data: { mentorId: admin.id, menteeId: ownMentee.id } });
  await prisma.mentorshipRelation.create({ data: { mentorId: otherOwner.id, menteeId: theirMentee.id } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const idsOf = async (query: string) => {
      const res = await page.request.get(`/api/candidates?${query}`);
      expect(res.ok()).toBeTruthy();
      const data = await res.json();
      return (data.candidates as { id: string }[]).map((c) => c.id);
    };

    const mineIds = await idsOf('mine=1');
    expect(mineIds).toContain(ownMentee.id);
    expect(mineIds).not.toContain(theirMentee.id);

    // Search alone finds the other owner's mentee…
    expect(await idsOf(`search=${encodeURIComponent('Minefilter Their')}`)).toContain(theirMentee.id);
    // …and the two filters INTERSECT rather than one resetting the other.
    expect(await idsOf(`mine=1&search=${encodeURIComponent('Minefilter Their')}`)).toHaveLength(0);
    expect(await idsOf(`mine=1&search=${encodeURIComponent('Minefilter Own')}`)).toEqual([ownMentee.id]);

    await page.goto('/admin/candidates');
    await expect(page.getByTestId(`candidate-card-${ownMentee.id}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`candidate-card-${theirMentee.id}`)).toBeVisible();

    await page.getByTestId('candidates-mine-filter').click();
    await expect(page).toHaveURL(/mine=1/);
    await expect(page.getByTestId(`candidate-card-${theirMentee.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`candidate-card-${ownMentee.id}`)).toBeVisible();

    // Shareable: the same URL opened fresh comes back filtered.
    await page.reload();
    await expect(page.getByTestId('candidates-mine-filter')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId(`candidate-card-${ownMentee.id}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`candidate-card-${theirMentee.id}`)).toHaveCount(0);

    // Back to everything, then hand the other owner's mentee over through the
    // existing selection bar — the same control an operator uses.
    await page.getByTestId('candidates-mine-filter').click();
    await expect(page).not.toHaveURL(/mine=1/);
    const theirCard = page.getByTestId(`candidate-card-${theirMentee.id}`);
    await expect(theirCard).toBeVisible({ timeout: 15_000 });
    await theirCard.getByRole('checkbox').check();
    await page.getByTestId('bulk-owner-select').selectOption(admin.id);
    await page.getByTestId('bulk-assign-owner').click();
    await expect(page.getByTestId('bulk-tag-note')).toContainText('1 reassigned', { timeout: 15_000 });

    await expect(async () => {
      const live = await prisma.mentorshipRelation.findFirst({
        where: { menteeId: theirMentee.id, status: 'ACTIVE' },
      });
      expect(live?.mentorId).toBe(admin.id);
    }).toPass({ timeout: 10_000 });

    // And now they are "mine".
    await page.getByTestId('candidates-mine-filter').click();
    await expect(page.getByTestId(`candidate-card-${theirMentee.id}`)).toBeVisible({ timeout: 15_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({
      where: { menteeId: { in: [ownMentee.id, theirMentee.id] } },
    });
    await cleanupByEmail(ownMenteeEmail);
    await cleanupByEmail(theirMenteeEmail);
    await cleanupByEmail(otherOwnerEmail);
    await cleanupByEmail(adminEmail);
  }
});
