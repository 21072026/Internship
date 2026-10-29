import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import { acceptConfirmDialog, confirmDialog } from './helpers/confirm';

// Org-defined segmentation attributes (#1920, part 1): an admin defines one in
// two languages on /admin/attributes, sees how many people carry a value,
// relabels and reorders it; another org's admin cannot see or touch it; a
// mentor is refused; and deleting one a report subscription slices by asks
// first (409 referenced) and then degrades the subscription to the unsliced
// report instead of leaving it pointing at nothing. Own organizations, so
// nothing races the default org.

const PW = 'Attributes123!';

test.describe('org attributes', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('oa-admin');
  const otherAdmin = uniqueEmail('oa-other');
  const mentor = uniqueEmail('oa-mentor');
  let orgId = '';
  let otherOrgId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `OA Org ${stamp}`, slug: `oa-${stamp}` } })).id;
    otherOrgId = (await prisma.organization.create({ data: { name: `OA Other ${stamp}`, slug: `oa-o-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `OA Admin ${stamp}`, orgId);
    await seedUser(otherAdmin, PW, 'ADMIN', `OA Other ${stamp}`, otherOrgId);
    await seedUser(mentor, PW, 'MENTOR', `OA Mentor ${stamp}`, orgId);
  });

  test.afterAll(async () => {
    await prisma.reportSubscription.deleteMany({ where: { orgId } });
    await prisma.orgAttribute.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    for (const email of [admin, otherAdmin, mentor]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.$disconnect();
  });

  test('define, count, relabel, reorder, isolate, and delete with degradation', async ({ page, browser }) => {
    test.setTimeout(180_000);
    await signInAndSettle(page, admin, PW, '/admin');
    await gotoSettled(page, '/admin/attributes');

    // A list attribute, named in two languages; the key is derived from the EN name.
    await page.getByTestId('new-attribute-label-en').fill('Department');
    await page.getByTestId('new-attribute-label-tr').fill('Bölüm');
    await page.getByTestId('new-attribute-options').fill('Engineering\nSales\nengineering\n');
    await page.getByTestId('create-attribute').click();
    await expect(page.getByTestId('attribute-department')).toBeVisible();
    const dept = await prisma.orgAttribute.findFirstOrThrow({ where: { orgId, key: 'department' } });
    expect(dept).toMatchObject({ labelEn: 'Department', labelTr: 'Bölüm', labelDe: '', type: 'SELECT', isSegmentable: true });
    expect(dept.options).toEqual(['Engineering', 'Sales']);

    // A date attribute through the API; a duplicate key is refused, a bad key too.
    const start = await page.request.post('/api/admin/attributes', { data: { labels: { en: 'Start date' }, type: 'DATE' } });
    expect(start.status()).toBe(201);
    expect((await start.json()).attribute.key).toBe('start_date');
    expect((await page.request.post('/api/admin/attributes', { data: { key: 'department', labels: { en: 'Dept' }, type: 'TEXT' } })).status()).toBe(409);
    expect((await page.request.post('/api/admin/attributes', { data: { key: 'Bad-Key', labels: { en: 'x' }, type: 'TEXT' } })).status()).toBe(400);
    expect((await page.request.post('/api/admin/attributes', { data: { labels: { en: 'Level' }, type: 'SELECT', options: [] } })).status()).toBe(400);

    // The value count is what the screen shows.
    const person = await prisma.user.findFirstOrThrow({ where: { email: mentor, orgId } });
    await prisma.userAttributeValue.create({ data: { orgId, userId: person.id, attributeId: dept.id, value: 'Sales' } });
    await gotoSettled(page, '/admin/attributes');
    await expect(page.getByTestId('attribute-department-count')).toContainText('1');

    // Relabel in German; reorder start_date to the top.
    await page.getByTestId('edit-attribute-department').click();
    await page.getByTestId('edit-attribute-department-label-de').fill('Abteilung');
    await page.getByTestId('save-attribute-department').click();
    await expect.poll(async () => (await prisma.orgAttribute.findUniqueOrThrow({ where: { id: dept.id } })).labelDe).toBe('Abteilung');
    const ids = (await prisma.orgAttribute.findMany({ where: { orgId }, orderBy: { sortOrder: 'asc' }, select: { id: true } })).map((a) => a.id);
    const reordered = await page.request.patch('/api/admin/attributes', { data: { order: [...ids].reverse() } });
    expect(reordered.status()).toBe(200);
    expect((await reordered.json()).attributes.map((a: { key: string }) => a.key)).toEqual(['start_date', 'department']);

    // Another org's admin sees none of it and cannot change it.
    const other = await browser.newPage();
    await signInAndSettle(other, otherAdmin, PW, '/admin');
    expect((await (await other.request.get('/api/admin/attributes')).json()).attributes).toEqual([]);
    expect((await other.request.patch('/api/admin/attributes', { data: { id: dept.id, isSegmentable: false } })).status()).toBe(404);
    expect((await other.request.delete('/api/admin/attributes', { data: { id: dept.id, confirm: true } })).status()).toBe(404);
    await other.close();

    // A mentor is refused.
    const mentorPage = await browser.newPage();
    await signInAndSettle(mentorPage, mentor, PW, '/mentor');
    expect((await mentorPage.request.get('/api/admin/attributes')).status()).toBe(403);
    await mentorPage.close();

    // A subscription slices by department: deleting asks first, then degrades it.
    const sub = await prisma.reportSubscription.create({
      data: { orgId, reportKey: 'source-conversion', params: { segmentBy: 'department', segment: 'Sales' }, cadence: 'WEEKLY', dayOfWeek: 1, hour: 6, locale: 'en', format: 'EMAIL_SUMMARY', recipientEmail: `oa-dean-${stamp}@example.com` },
    });
    await page.getByTestId('delete-attribute-department').click();
    // The first confirm is answered 409: the dialog stays and names the reference.
    await confirmDialog(page).getByTestId('confirm-dialog-confirm').click();
    await expect(confirmDialog(page)).toContainText('1 scheduled report');
    await acceptConfirmDialog(page);
    await expect.poll(async () => prisma.orgAttribute.count({ where: { id: dept.id } })).toBe(0);
    expect(await prisma.userAttributeValue.count({ where: { attributeId: dept.id } })).toBe(0);
    expect((await prisma.reportSubscription.findUniqueOrThrow({ where: { id: sub.id } })).params).toEqual({});
  });
  test('import values by CSV: preview writes nothing, apply writes, unmatched and invalid rows are reported', async ({ page }) => {
    test.setTimeout(180_000);
    await signInAndSettle(page, admin, PW, '/admin');
    for (const body of [
      { key: 'level', labels: { en: 'Level', de: 'Ebene' }, type: 'SELECT', options: ['Junior', 'Senior'] },
      { key: 'joined', labels: { en: 'Joined' }, type: 'DATE' },
    ]) {
      expect((await page.request.post('/api/admin/attributes', { data: body })).status()).toBe(201);
    }
    const person = await prisma.user.findFirstOrThrow({ where: { email: mentor, orgId } });
    const csv = [
      'email;Ebene;joined',
      `${mentor.toUpperCase()};senior;01.03.2024`,
      `nobody-${stamp}@example.com;Junior;`,
      `${otherAdmin};Junior;`,
      `${admin};Principal;2024-01-01`,
    ].join('\n');

    await gotoSettled(page, '/admin/attributes');
    await page.getByTestId('attribute-import-text').fill(csv);
    await page.getByTestId('attribute-import-preview').click();
    await expect(page.getByTestId('attribute-import-counts')).toContainText('1');
    const issues = page.getByTestId('attribute-import-issues');
    await expect(issues).toContainText(`nobody-${stamp}@example.com`);
    // Another organization's person is "not found", like an unknown address.
    await expect(issues).toContainText(otherAdmin);
    await expect(issues).toContainText('level: not_an_option');
    expect(await prisma.userAttributeValue.count({ where: { userId: person.id } })).toBe(0);

    await page.getByTestId('attribute-import-apply').click();
    await expect(page.getByTestId('attribute-import-report')).toContainText('Imported');
    const values = await prisma.userAttributeValue.findMany({ where: { userId: person.id }, include: { attribute: { select: { key: true } } } });
    expect(Object.fromEntries(values.map((v) => [v.attribute.key, v.value]))).toEqual({ level: 'Senior', joined: '2024-03-01' });
    expect(values.every((v) => v.orgId === orgId)).toBe(true);
    await expect(page.getByTestId('attribute-level-count')).toContainText('1');

    // A second apply of the same file changes nothing.
    const again = await page.request.post('/api/admin/attributes/import', { data: { text: csv, apply: true } });
    expect((await again.json()).counts.UNCHANGED).toBe(1);
    // A typo in a header refuses the whole file.
    const typo = await page.request.post('/api/admin/attributes/import', { data: { text: 'email,levle\na@example.com,Junior' } });
    expect(typo.status()).toBe(400);
    expect(await typo.json()).toMatchObject({ code: 'unknown_column', column: 'levle' });
  });
});
