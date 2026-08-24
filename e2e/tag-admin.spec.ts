import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * Tag management (#845).
 *
 * The caps from #887 stop the vocabulary growing without limit; this screen is
 * what repairs the drift that already happened. So the assertions are about
 * repair: a rename that keeps the id (and therefore everyone's label and every
 * saved view), and a merge that loses nobody.
 */

const PASSWORD = 'TagAdmin123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * A tag is org-scoped by construction, so everyone in this spec has to be in
 * the same org — and the orgId reaches the handler through the JWT, so it must
 * be set BEFORE sign-in, not after.
 */
async function inDefaultOrg(userIds: string[]): Promise<string> {
  const org =
    (await prisma.organization.findFirst({ where: { slug: 'default' } })) ??
    (await prisma.organization.create({ data: { name: 'Default', slug: 'default' } }));
  await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { orgId: org.id } });
  return org.id;
}

test('an admin renames, merges and deletes tags without losing people', async ({ page }) => {
  const adminEmail = uniqueEmail('tagadm');
  const aEmail = uniqueEmail('tagged-a');
  const bEmail = uniqueEmail('tagged-b');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Tag Admin');
  const a = await seedUser(aEmail, 'x', 'MENTEE', 'Tagged Person A');
  const b = await seedUser(bEmail, 'x', 'MENTEE', 'Tagged Person B');
  const orgId = await inDefaultOrg([admin.id, a.id, b.id]);

  const stamp = Date.now();
  // The classic drift: one idea written two ways.
  const backend = await prisma.tag.create({ data: { orgId, name: `Backend ${stamp}`, color: '#2563eb' } });
  const backEnd = await prisma.tag.create({ data: { orgId, name: `back-end ${stamp}`, color: null } });
  const spare = await prisma.tag.create({ data: { orgId, name: `Spare ${stamp}` } });
  await prisma.userTag.createMany({
    data: [
      { userId: a.id, tagId: backend.id },
      { userId: a.id, tagId: backEnd.id }, // carries BOTH — must not end up doubled
      { userId: b.id, tagId: backEnd.id }, // carries only the duplicate — must be moved
      { userId: b.id, tagId: spare.id },
    ],
  });

  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
    await page.goto('/admin/tags');
    await expect(page.getByTestId('tag-admin-table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`tag-usage-${backEnd.id}`)).toHaveText('2');

    // Rename in place: the id survives, so nobody loses the label.
    await page.getByTestId(`tag-edit-${backend.id}`).click();
    await page.getByTestId('tag-edit-name').fill(`Backend Engineering ${stamp}`);
    await page.getByTestId('tag-edit-save').click();
    await expect(page.getByTestId(`tag-row-${backend.id}`)).toContainText(`Backend Engineering ${stamp}`, { timeout: 15_000 });
    const renamed = await prisma.tag.findUnique({ where: { id: backend.id } });
    expect(renamed!.name).toBe(`Backend Engineering ${stamp}`);
    expect(await prisma.userTag.count({ where: { tagId: backend.id } })).toBe(1);

    // Merge the duplicate into it.
    await page.getByTestId(`tag-merge-${backEnd.id}`).click();
    await page.getByTestId('tag-merge-target').selectOption(backend.id);
    await page.getByTestId('tag-merge-confirm').click();

    // The duplicate is gone and nobody lost a marking: A already had the target
    // (so still one row), B was moved onto it.
    await expect
      .poll(async () => prisma.tag.count({ where: { id: backEnd.id } }), { timeout: 15_000 })
      .toBe(0);
    const holders = await prisma.userTag.findMany({ where: { tagId: backend.id }, select: { userId: true } });
    expect(new Set(holders.map((h) => h.userId))).toEqual(new Set([a.id, b.id]));
    expect(holders).toHaveLength(2);

    // Deleting warns with the real usage count first, and takes only the label.
    await page.getByTestId(`tag-delete-${spare.id}`).click();
    await expect(page.getByTestId('tag-delete-warning')).toContainText('1');
    await page.getByTestId('tag-delete-confirm').click();
    await expect
      .poll(async () => prisma.tag.count({ where: { id: spare.id } }), { timeout: 15_000 })
      .toBe(0);
    // The person is untouched — a label is an opinion about somebody, and
    // deleting the opinion is not deleting them.
    expect(await prisma.user.count({ where: { id: b.id } })).toBe(1);
  } finally {
    await prisma.tag.deleteMany({ where: { orgId, name: { contains: String(stamp) } } });
    await cleanupByEmail(bEmail);
    await cleanupByEmail(aEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('renaming onto an existing name is refused, and a non-admin cannot manage tags', async ({ page }) => {
  const adminEmail = uniqueEmail('tagadm2');
  const menteeEmail = uniqueEmail('tagnonadm');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Tag Admin Two');
  const outsider = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Tag Outsider');
  const orgId = await inDefaultOrg([admin.id, outsider.id]);
  const stamp = Date.now();
  const one = await prisma.tag.create({ data: { orgId, name: `Alpha ${stamp}` } });
  const two = await prisma.tag.create({ data: { orgId, name: `Beta ${stamp}` } });

  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');

    // Case-insensitively equal counts as a clash — otherwise "Alpha" could be
    // renamed to "alpha" and sit beside itself, recreating the drift.
    const clash = await page.request.patch(`/api/tags/${two.id}`, { data: { name: `alpha ${stamp}` } });
    expect(clash.status()).toBe(409);
    expect((await clash.json()).code).toBe('duplicate');

    // Merging a tag into itself is refused rather than silently deleting it.
    const self = await page.request.post(`/api/tags/${one.id}/merge`, { data: { into: one.id } });
    expect(self.status()).toBe(400);
    expect(await prisma.tag.count({ where: { id: one.id } })).toBe(1);

    // A mentee may apply labels but not rewrite the vocabulary.
    await signInAndSettle(page, menteeEmail, PASSWORD, '/portal');
    const forbidden = await page.request.patch(`/api/tags/${one.id}`, { data: { name: `Hijacked ${stamp}` } });
    expect(forbidden.status()).toBe(401);
    await page.goto('/admin/tags');
    await expect(page).not.toHaveURL(/\/admin\/tags/);
  } finally {
    await prisma.tag.deleteMany({ where: { orgId, name: { contains: String(stamp) } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
