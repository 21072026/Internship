import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle, signInViaApi } from './helpers/auth';

// The e-mail composer's recipient list pages and searches on the server
// (#1438): one page of 50, "show more" for the rest, and "select all" picks
// every match of the search — counted — without loading them all into the list.
async function seedProgramme(stamp: string, mentees: number) {
  const org = await prisma.organization.create({ data: { name: `Recipients ${stamp}`, slug: `recipients-${stamp}` } });
  const pw = 'Recipients123!';
  const adminEmail = uniqueEmail('rcp-admin');
  await seedUser(adminEmail, pw, 'ADMIN', `RCP Admin ${stamp}`, org.id);
  const mentor = await seedUser(uniqueEmail('rcp-mentor'), pw, 'MENTOR', `RCP Mentor ${stamp}`, org.id);
  await prisma.user.createMany({
    data: Array.from({ length: mentees }, (_, i) => ({
      email: `rcp-mentee-${i}.${stamp}@example.test`,
      password: '!x',
      role: 'MENTEE' as const,
      fullName: `${i < 5 ? 'Quillon' : 'Plain'} Mentee ${String(i).padStart(2, '0')} ${stamp}`,
      skills: [],
      orgId: org.id,
    })),
  });
  const rows = await prisma.user.findMany({ where: { orgId: org.id, role: 'MENTEE' }, select: { id: true } });
  await prisma.mentorshipRelation.createMany({
    data: rows.map((m) => ({ mentorId: mentor.id, menteeId: m.id, orgId: org.id, status: 'ACTIVE' as const })),
  });
  return { org, adminEmail, pw };
}

async function dropOrg(orgId: string) {
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
}

test('view=recipients: name and language only, one page, every match with all=1', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { org, adminEmail, pw } = await seedProgramme(stamp, 60);
  const api = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(api, adminEmail, pw)).ok).toBe(true);
    const first = await (await api.get('/api/mentorship?view=recipients')).json();
    expect(first.total).toBe(60);
    expect(first.recipients).toHaveLength(50);
    // The composer's read carries no e-mail address.
    expect(JSON.stringify(first.recipients)).not.toContain('@example.test');
    expect(Object.keys(first.recipients[0].mentee).sort()).toEqual(['fullName', 'id', 'preferredLanguage']);

    const all = await (await api.get('/api/mentorship?view=recipients&all=1')).json();
    expect(all.recipients).toHaveLength(60);
    const searched = await (await api.get('/api/mentorship?view=recipients&all=1&search=Quillon')).json();
    expect(searched.total).toBe(5);
  } finally {
    await api.dispose();
    await dropOrg(org.id);
  }
});

test('the composer lists one page, loads more, and "select all" picks every match of the search', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { org, adminEmail, pw } = await seedProgramme(stamp, 60);
  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, '/admin/email');
    const rowBoxes = page.locator('label:has(input[type="checkbox"]) >> input[type="checkbox"]:not([data-testid])');
    await expect(rowBoxes).toHaveCount(50, { timeout: 30_000 });
    await page.getByTestId('email-recipient-more').click();
    await expect(rowBoxes).toHaveCount(60);

    await page.getByTestId('email-recipient-search').fill('Quillon');
    await expect(rowBoxes).toHaveCount(5, { timeout: 15_000 });
    await page.getByTestId('email-recipient-select-all').check();
    await expect(page.getByText(/\(5\/5\)/)).toBeVisible();

    // The pick survives clearing the search.
    await page.getByTestId('email-recipient-search').fill('');
    await expect(page.getByText(/\(5\/60\)/)).toBeVisible({ timeout: 15_000 });
  } finally {
    await dropOrg(org.id);
  }
});
