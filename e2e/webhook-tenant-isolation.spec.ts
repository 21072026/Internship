import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Webhook tenant isolation (#2357, epic #2349). A webhook belongs to the tenant
// that created it; one tenant's admin must not see, edit or delete another
// tenant's endpoints, and — the core leak this fixes — one tenant's event must
// never fan out to another's webhook. The dispatch scoping is unit-level (an
// HTTP endpoint is impractical in e2e); this asserts the admin-management
// isolation and that a created webhook is stamped with the creator's org.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function orgWithAdmin(tag: string) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}-${tag}`;
  const org = await prisma.organization.create({ data: { name: `WH ${tag} ${stamp}`, slug: `wh-${stamp}` } });
  const email = uniqueEmail(`wh-${tag}`);
  const admin = await seedUser(email, 'WhPass123', 'ADMIN', `${tag} Admin`);
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  return { org, email };
}

test('a tenant admin sees, edits and deletes only its own webhooks', async ({ page }) => {
  const a = await orgWithAdmin('A');
  const b = await orgWithAdmin('B');
  // A webhook in each org, written straight to the DB with its orgId.
  const hookA = await prisma.webhook.create({ data: { url: 'https://a.example/hook', secret: 's', events: ['interaction.logged'], orgId: a.org.id } });
  const hookB = await prisma.webhook.create({ data: { url: 'https://b.example/hook', secret: 's', events: ['interaction.logged'], orgId: b.org.id } });
  try {
    await signInAndSettle(page, a.email, 'WhPass123', '/admin');

    // GET lists only org A's webhook.
    const list = await (await page.request.get('/api/admin/webhooks')).json();
    const ids = (list.webhooks as { id: string }[]).map((w) => w.id);
    expect(ids).toContain(hookA.id);
    expect(ids).not.toContain(hookB.id);

    // DELETE of org B's webhook is a no-op (scoped deleteMany matches nothing).
    const del = await page.request.delete(`/api/admin/webhooks?id=${hookB.id}`);
    // B's webhook still exists.
    expect(await prisma.webhook.findUnique({ where: { id: hookB.id } })).not.toBeNull();

    // PATCH of org B's webhook is refused/no-op too.
    await page.request.patch(`/api/admin/webhooks?id=${hookB.id}`, { data: { active: false } });
    expect((await prisma.webhook.findUnique({ where: { id: hookB.id } }))?.active).toBe(true);

    // A's own webhook CAN be deleted.
    await page.request.delete(`/api/admin/webhooks?id=${hookA.id}`);
    expect(await prisma.webhook.findUnique({ where: { id: hookA.id } })).toBeNull();
  } finally {
    await prisma.webhook.deleteMany({ where: { id: { in: [hookA.id, hookB.id] } } }).catch(() => {});
    for (const x of [a, b]) {
      await cleanupByEmail(x.email);
      await prisma.organization.delete({ where: { id: x.org.id } }).catch(() => {});
    }
  }
});

test('a webhook created through the API is stamped with the creator’s org', async ({ page }) => {
  const a = await orgWithAdmin('C');
  let createdId: string | undefined;
  try {
    await signInAndSettle(page, a.email, 'WhPass123', '/admin');
    const res = await page.request.post('/api/admin/webhooks', {
      data: { url: 'https://example.com/hook', events: ['interaction.logged'] },
    });
    expect(res.status()).toBe(201);
    createdId = (await res.json()).webhook.id;
    const row = await prisma.webhook.findUnique({ where: { id: createdId! } });
    expect(row?.orgId).toBe(a.org.id);
  } finally {
    if (createdId) await prisma.webhook.delete({ where: { id: createdId } }).catch(() => {});
    await cleanupByEmail(a.email);
    await prisma.organization.delete({ where: { id: a.org.id } }).catch(() => {});
  }
});
