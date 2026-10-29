import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// /admin/availability (#2005): an admin runs any mentor's hours in their own
// organization without impersonating them, through the endpoints the mentor's
// own page uses. Another org's mentor stays out of reach — not in the picker,
// and 404 (never a 403 that confirms the id) on the read.

const PW = 'AdminAvail123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const emails = {
  admin: uniqueEmail('adm-av-admin'),
  mentor: uniqueEmail('adm-av-mentor'),
  foreign: uniqueEmail('adm-av-foreign'),
};
const ids = { orgs: [] as string[], mentor: '', foreign: '', foreignSlot: '' };

test.describe.serial('admin availability (#2005)', () => {
  test.beforeAll(async () => {
    const orgA = await prisma.organization.create({ data: { name: `AdmAv A ${stamp}`, slug: `adm-av-a-${stamp}` } });
    const orgB = await prisma.organization.create({ data: { name: `AdmAv B ${stamp}`, slug: `adm-av-b-${stamp}` } });
    ids.orgs.push(orgA.id, orgB.id);
    await seedUser(emails.admin, PW, 'ADMIN', `AdmAv Admin ${stamp}`, orgA.id);
    // No time zone on purpose: the page must say the mentor never set one.
    ids.mentor = (await seedUser(emails.mentor, PW, 'MENTOR', `AdmAv Mentor ${stamp}`, orgA.id)).id;
    ids.foreign = (await seedUser(emails.foreign, PW, 'MENTOR', `AdmAv Foreign ${stamp}`, orgB.id)).id;
    ids.foreignSlot = (
      await prisma.availabilitySlot.create({ data: { mentorId: ids.foreign, weekday: 1, startTime: '09:00', endTime: '10:00' } })
    ).id;
  });

  test.afterAll(async () => {
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: ids.orgs } } }).catch(() => {});
    await prisma.$disconnect();
  });

  test('another organization’s mentor stays out of reach', { tag: '@smoke' }, async ({ page }) => {
    await signInAndSettle(page, emails.admin, PW, '/admin');
    expect((await page.request.get(`/api/availability?mentorId=${ids.foreign}`)).status()).toBe(404);
    expect((await page.request.get(`/api/availability/exceptions?mentorId=${ids.foreign}`)).status()).toBe(404);
    const post = await page.request.post('/api/availability', {
      data: { weekday: 2, startTime: '09:00', endTime: '10:00', mentorId: ids.foreign },
    });
    expect(post.status()).toBe(403);
    const patch = await page.request.patch('/api/availability', { data: { id: ids.foreignSlot, startTime: '11:00', endTime: '12:00' } });
    expect(patch.status()).toBe(404);
    expect(await prisma.availabilitySlot.count({ where: { mentorId: ids.foreign } })).toBe(1);
    const slot = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: ids.foreignSlot } });
    expect([slot.startTime, slot.endTime]).toEqual(['09:00', '10:00']);
  });

  test('an admin lists, adds, edits and removes a mentor’s hours without impersonating', async ({ page }) => {
    await signInAndSettle(page, emails.admin, PW, '/admin');
    await gotoSettled(page, '/admin/availability');
    const picker = page.getByTestId('admin-availability-mentor');
    await expect(picker.locator('option', { hasText: `AdmAv Mentor ${stamp}` })).toHaveCount(1);
    await expect(picker.locator('option', { hasText: `AdmAv Foreign ${stamp}` })).toHaveCount(0);
    await picker.selectOption(ids.mentor);

    // The "never set a zone" variant, in the admin's words, with no link to the
    // admin's own profile.
    await expect(page.getByTestId('availability-zone')).toContainText('This mentor never set a time zone');

    // Add: Monday 09:00–10:00, written for the mentor, not for the admin.
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => prisma.availabilitySlot.count({ where: { mentorId: ids.mentor } })).toBe(1);
    const slot = await prisma.availabilitySlot.findFirstOrThrow({ where: { mentorId: ids.mentor } });
    await expect(page.getByTestId(`slot-${slot.id}`)).toContainText('09:00–10:00');

    // Edit in place.
    await page.getByTestId(`slot-${slot.id}`).getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByTestId(`slot-edit-${slot.id}`);
    await edit.getByLabel('From').fill('11:00');
    await edit.getByLabel('To').fill('12:00');
    await edit.getByTestId('slot-edit-save').click();
    await expect(page.getByTestId(`slot-${slot.id}`)).toContainText('11:00–12:00');

    // Remove.
    await page.getByTestId(`slot-${slot.id}`).getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId(`slot-${slot.id}`)).toHaveCount(0);
    expect(await prisma.availabilitySlot.count({ where: { mentorId: ids.mentor } })).toBe(0);
  });
});
