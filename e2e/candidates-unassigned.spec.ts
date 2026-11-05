import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// Unassigned candidates (#1440): people who registered but have no ACTIVE
// relation could not be listed anywhere. The stage filter now offers
// "Unassigned" (`?status=unassigned`): no ACTIVE relation, a finished pairing
// included, archived people excluded, oldest registration first. The
// dashboard explains that its stage bars count pairings and links the
// unassigned queue.

test.afterAll(async () => prisma.$disconnect());

const PW = 'Unassigned123!';

test('the unassigned queue lists exactly the candidates with no active relation, oldest first', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const s = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Unassigned ${s}`, slug: `unassigned-${s}` } });
  const emails = ['un-admin', 'un-mentor', 'un-active', 'un-finished', 'un-never', 'un-archived'].map((p) => uniqueEmail(p));
  const [adminEmail, mentorEmail, activeEmail, finishedEmail, neverEmail, archivedEmail] = emails;
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'Unassigned Admin', org.id);
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Unassigned Mentor', org.id);
    const active = await seedUser(activeEmail, PW, 'MENTEE', 'Paired Pelin', org.id);
    const finished = await seedUser(finishedEmail, PW, 'MENTEE', 'Finished Fatih', org.id);
    const never = await seedUser(neverEmail, PW, 'MENTEE', 'Waiting Weronika', org.id);
    const archived = await seedUser(archivedEmail, PW, 'MENTEE', 'Archived Arda', org.id);
    // Registration order: the never-paired candidate waited longest.
    await prisma.user.update({ where: { id: never.id }, data: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    await prisma.user.update({ where: { id: finished.id }, data: { createdAt: new Date('2026-02-01T00:00:00Z') } });
    await prisma.user.update({ where: { id: archived.id }, data: { isActive: false } });
    await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: active.id } });
    await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: finished.id, status: 'COMPLETED', completedAt: new Date() } });

    await signInAndSettle(page, adminEmail, PW, '/admin');
    await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);

    // The API: exactly the two, oldest registration first, and the export (`all=1`) gives the same set.
    const res = await page.request.get('/api/candidates?status=unassigned');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual([never.id, finished.id]);
    expect(body.total).toBe(2);
    const exported = await (await page.request.get('/api/candidates?status=unassigned&all=1')).json();
    expect(exported.candidates.map((c: { id: string }) => c.id).sort()).toEqual([never.id, finished.id].sort());
    // It composes with the other filters, and ?sort= overrides the default order.
    const searched = await (await page.request.get('/api/candidates?status=unassigned&search=Waiting')).json();
    expect(searched.candidates.map((c: { id: string }) => c.id)).toEqual([never.id]);
    const newest = await (await page.request.get('/api/candidates?status=unassigned&sort=newest')).json();
    expect(newest.candidates.map((c: { id: string }) => c.id)).toEqual([finished.id, never.id]);

    // The dashboard explains its bars and links the queue.
    await gotoSettled(page, '/admin');
    await expect(page.getByTestId('dashboard-pipeline-note')).toHaveText('Stage counts are pairings (2 in total), not people.');
    const link = page.getByTestId('dashboard-unassigned');
    await expect(link).toHaveText('2 candidates are not assigned yet →');
    await link.click();
    await page.waitForURL(/\/admin\/candidates\?status=unassigned/);
    await expect(page.getByTestId('candidates-status-filter-chip')).toContainText('Unassigned');
    const list = page.getByTestId('candidates-desktop-list');
    await expect(list.getByText('Waiting Weronika', { exact: true })).toBeVisible();
    await expect(list.getByText('Finished Fatih', { exact: true })).toBeVisible();
    await expect(list.getByText('Paired Pelin', { exact: true })).toHaveCount(0);
    await expect(list.getByText('Archived Arda', { exact: true })).toHaveCount(0);
  } finally {
    for (const e of emails) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
