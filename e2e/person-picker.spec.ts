import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle, signInViaApi } from './helpers/auth';
import { pickPerson } from './helpers/personPicker';

// The mentorship pickers no longer download the tenant (#1437). The API half:
// `view=mentorAvailability` never returns a COMPANY or SOURCE account, `roles`
// narrows, `limit` answers one bounded page with its `total`, `search` matches
// on the server — and none of it reaches across a tenant. The UI half: the
// assign form's mentee field finds one person among many by typing.
type PickerUser = { id: string; fullName: string; role: string };

async function seedOrg(stamp: string, label: string) {
  return prisma.organization.create({ data: { name: `Picker ${label} ${stamp}`, slug: `picker-${label}-${stamp}` } });
}

async function dropOrg(orgId: string) {
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
}

test('mentorAvailability: picker roles only, roles narrows, limit pages with a total, tenant-scoped', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'PickerPass123!';
  const org = await seedOrg(stamp, 'a');
  const other = await seedOrg(stamp, 'b');
  const admin = await playwright.request.newContext({ baseURL });
  try {
    const adminEmail = uniqueEmail('pick-admin');
    await seedUser(adminEmail, pw, 'ADMIN', `Pick Admin ${stamp}`, org.id);
    const mentor = await seedUser(uniqueEmail('pick-mentor'), pw, 'MENTOR', `Pick Mentor ${stamp}`, org.id);
    const company = await seedUser(uniqueEmail('pick-company'), pw, 'COMPANY', `Pick Company ${stamp}`, org.id);
    const source = await seedUser(uniqueEmail('pick-source'), pw, 'SOURCE', `Pick Source ${stamp}`, org.id);
    const mentees = [];
    for (let i = 0; i < 7; i++) mentees.push(await seedUser(uniqueEmail(`pick-m${i}`), pw, 'MENTEE', `Pick Mentee ${i} ${stamp}`, org.id));
    const foreign = await seedUser(uniqueEmail('pick-foreign'), pw, 'MENTEE', `Pick Mentee foreign ${stamp}`, other.id);

    expect((await signInViaApi(admin, adminEmail, pw)).ok).toBe(true);
    const get = async (qs: string) => {
      const res = await admin.get(`/api/users?view=mentorAvailability&${qs}`);
      expect(res.status()).toBe(200);
      return (await res.json()) as { users: PickerUser[]; total?: number; limit?: number };
    };

    // No parameters: the historical list, minus the accounts no picker offers.
    const all = await get(`search=${encodeURIComponent(stamp)}`);
    const ids = new Set(all.users.map((u) => u.id));
    expect(ids.has(mentor.id)).toBe(true);
    expect(ids.has(mentees[0].id)).toBe(true);
    expect(ids.has(company.id)).toBe(false);
    expect(ids.has(source.id)).toBe(false);
    expect(ids.has(foreign.id)).toBe(false);
    expect(all.total).toBeUndefined();

    // roles narrows; a role no picker offers answers nobody, not everybody.
    const mentorsOnly = await get(`roles=ADMIN,MENTOR&search=${encodeURIComponent(stamp)}`);
    expect(mentorsOnly.users.every((u) => u.role === 'ADMIN' || u.role === 'MENTOR')).toBe(true);
    expect(mentorsOnly.users.map((u) => u.id)).toContain(mentor.id);
    expect((await get(`roles=COMPANY&search=${encodeURIComponent(stamp)}`)).users).toHaveLength(0);

    // limit: one bounded page, sorted by name, and the true total beside it.
    const page = await get(`roles=MENTEE&limit=3&search=${encodeURIComponent(`Pick Mentee`)}`);
    expect(page.users).toHaveLength(3);
    expect(page.total).toBe(7);
    expect(page.limit).toBe(3);
    expect(page.users.map((u) => u.fullName)).toEqual([...page.users.map((u) => u.fullName)].sort((a, b) => a.localeCompare(b)));

    // An oversized limit is clamped, never honoured.
    expect((await get('limit=100000')).limit).toBe(50);
  } finally {
    await admin.dispose();
    await dropOrg(org.id);
    await dropOrg(other.id);
  }
});

test('the assign form finds a mentee by typing, among more people than one page holds', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'PickerPass123!';
  const org = await seedOrg(stamp, 'ui');
  try {
    const adminEmail = uniqueEmail('pickui-admin');
    await seedUser(adminEmail, pw, 'ADMIN', `PickUI Admin ${stamp}`, org.id);
    const mentor = await seedUser(uniqueEmail('pickui-mentor'), pw, 'MENTOR', `PickUI Mentor ${stamp}`, org.id);
    // More than one page (20) of mentees, so the "keep typing" line shows.
    await prisma.user.createMany({
      data: Array.from({ length: 24 }, (_, i) => ({
        email: `pickui-bulk-${i}.${stamp}@example.test`,
        password: '!x',
        role: 'MENTEE' as const,
        fullName: `Bulk Mentee ${String(i).padStart(2, '0')} ${stamp}`,
        skills: [],
        orgId: org.id,
      })),
    });
    const target = await seedUser(uniqueEmail('pickui-target'), pw, 'MENTEE', `Zephyrine Target ${stamp}`, org.id);

    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, '/admin/mentorship');
    await page.getByRole('button', { name: 'Assign mentorship' }).first().click();
    const dialog = page.getByRole('dialog');

    // Opening the field lists one page and says there are more.
    await dialog.getByTestId('assign-mentee-input').focus();
    await expect(dialog.getByTestId('assign-mentee-listbox').getByRole('option')).toHaveCount(20, { timeout: 20_000 });
    await expect(dialog.getByTestId('assign-mentee-status')).toContainText('of');

    // Keyboard: type, arrow down, Enter.
    await dialog.getByTestId('assign-mentee-input').fill('Zephyrine');
    await expect(dialog.getByTestId(`assign-mentee-option-${target.id}`)).toBeVisible({ timeout: 20_000 });
    await dialog.getByTestId('assign-mentee-input').press('ArrowDown');
    await dialog.getByTestId('assign-mentee-input').press('Enter');
    await expect(dialog.getByTestId('assign-mentee-input')).toHaveValue(target.fullName);

    await dialog.locator('select').first().selectOption(mentor.id);
    await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect
      .poll(() => prisma.mentorshipRelation.count({ where: { mentorId: mentor.id, menteeId: target.id } }), { timeout: 20_000 })
      .toBe(1);

    // Clicking works too (the helper the other specs use).
    await page.getByRole('button', { name: 'Assign mentorship' }).first().click();
    await pickPerson(page.getByRole('dialog'), 'assign-mentee', target);
  } finally {
    await dropOrg(org.id);
  }
});
