import { test, expect, type Page } from '@playwright/test';
import { prisma } from './helpers/db';
import { gotoSettled } from './helpers/auth';
import { seedTwoTenants, signInAsTenantActor, type SeededTenant, type TwoTenants } from './helpers/tenants';

/**
 * Cross-world isolation of the audit trail, the support queue and the content
 * pools — with MT_ENFORCE_ISOLATION **off**, so the routes have to scope
 * themselves (the pattern of e2e/tenant-scope-users-companies.spec.ts, #2542).
 *
 * Measured before the fix, on one database holding both products:
 *   - a MARKETING admin's activity log listed every INTERNSHIP login;
 *   - the support queue listed, and let an admin reply to or close, every
 *     tenant's tickets;
 *   - a message template or shared goal written in one org was offered in the
 *     other (the org-wide pool was one pool);
 *   - `PATCH/DELETE /api/admin/announcements/<id>` edited another tenant's
 *     broadcast, and its image was served to anybody signed in;
 *   - the MARKETING documents page offered the internship CV / cover-letter
 *     built-ins.
 *
 * Every exclusion has its positive twin, or a route that returned nothing at
 * all would pass it.
 */

let tenants: TwoTenants;
const stamp = Date.now();
const created = { tickets: [] as string[], announcements: [] as string[], messageTemplates: [] as string[], goalTemplates: [] as string[] };

async function seedTicket(t: SeededTenant) {
  const ticket = await prisma.supportTicket.create({
    data: {
      requesterId: t.mentee.id,
      subject: `iso ticket ${t.label} ${stamp}`,
      messages: { create: { senderId: t.mentee.id, body: `help from ${t.label} ${stamp}` } },
    },
    select: { id: true },
  });
  created.tickets.push(ticket.id);
  return ticket.id;
}

async function seedAnnouncement(t: SeededTenant) {
  const a = await prisma.announcement.create({
    data: {
      text: `iso announcement ${t.label} ${stamp}`,
      sentById: t.admin.id,
      recipientCount: 0,
      orgId: t.org.id,
      // A 1×1 PNG is enough: the route only streams the bytes back.
      image: {
        create: {
          contentType: 'image/png',
          size: 4,
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        },
      },
    },
    select: { id: true },
  });
  created.announcements.push(a.id);
  return a.id;
}

const tickets: Record<string, string> = {};
const announcements: Record<string, string> = {};

test.beforeAll(async () => {
  tenants = await seedTwoTenants({ verticalA: 'INTERNSHIP', verticalB: 'MARKETING' });
  for (const t of [tenants.orgA, tenants.orgB]) {
    tickets[t.label] = await seedTicket(t);
    announcements[t.label] = await seedAnnouncement(t);
  }
});

test.afterAll(async () => {
  if (!tenants) return;
  await prisma.supportTicket.deleteMany({ where: { id: { in: created.tickets } } });
  await prisma.announcement.deleteMany({ where: { id: { in: created.announcements } } });
  await prisma.messageTemplate.deleteMany({ where: { id: { in: created.messageTemplates } } });
  await prisma.projectTaskTemplate.deleteMany({ where: { id: { in: created.goalTemplates } } });
  await prisma.activityLog.deleteMany({ where: { orgId: { in: tenants.orgIds } } });
  await tenants.cleanup();
});

const DIRECTIONS: Array<[string, (t: TwoTenants) => [SeededTenant, SeededTenant]]> = [
  ['INTERNSHIP admin → MARKETING tenant', (t) => [t.orgA, t.orgB]],
  ['MARKETING admin → INTERNSHIP tenant', (t) => [t.orgB, t.orgA]],
];

async function activityFor(page: Page, q: string): Promise<{ id: string; actorEmail: string | null; orgId: string | null }[]> {
  const res = await page.request.get(`/api/admin/activity?q=${encodeURIComponent(q)}`);
  expect(res.status()).toBe(200);
  return (await res.json()).items;
}

for (const [label, pick] of DIRECTIONS) {
  test(`activity log and support queue hold only the own tenant · ${label}`, { tag: '@smoke' }, async ({ page }) => {
    const [own, other] = pick(tenants);
    // Both admins sign in, so each has at least its own `auth.*` entries —
    // written by the real sign-in path, which stamps the org itself.
    await signInAsTenantActor(page, other.admin);
    await signInAsTenantActor(page, own.admin);

    const foreign = await activityFor(page, other.admin.email);
    expect(foreign, 'the activity log leaked another tenant\'s entries').toEqual([]);
    const mine = await activityFor(page, own.admin.email);
    expect(mine.length, 'the admin\'s own sign-in is in their own log').toBeGreaterThan(0);
    for (const row of mine) expect(row.orgId).toBe(own.org.id);

    const res = await page.request.get('/api/admin/support');
    expect(res.status()).toBe(200);
    const ids = ((await res.json()).tickets as { id: string }[]).map((t) => t.id);
    expect(ids, 'the support queue leaked another tenant\'s ticket').not.toContain(tickets[other.label]);
    expect(ids).toContain(tickets[own.label]);
  });

  test(`a foreign ticket cannot be replied to or closed · ${label}`, async ({ page }) => {
    const [own, other] = pick(tenants);
    await signInAsTenantActor(page, own.admin);
    const snapshot = () =>
      prisma.supportTicket.findUniqueOrThrow({
        where: { id: tickets[other.label] },
        select: { status: true, assignedAdminId: true, updatedAt: true, _count: { select: { messages: true } } },
      });
    const before = await snapshot();

    const reply = await page.request.post('/api/admin/support', { data: { ticketId: tickets[other.label], body: 'cross-tenant reply' } });
    expect(reply.status()).toBe(404);
    const close = await page.request.put('/api/admin/support', { data: { ticketId: tickets[other.label], status: 'CLOSED' } });
    expect(close.status()).toBe(404);
    const assign = await page.request.put('/api/admin/support', { data: { ticketId: tickets[other.label], assignToMe: true } });
    expect(assign.status()).toBe(404);

    // Asked of the database: a 404 that still wrote would pass the above.
    // (The other direction's positive twin may have replied to this ticket
    // already, so compare with the state before this test, not with the seed.)
    expect(await snapshot()).toEqual(before);
    expect(before.assignedAdminId).not.toBe(own.admin.id);

    // Positive twin: the own ticket takes the reply.
    const ownReply = await page.request.post('/api/admin/support', { data: { ticketId: tickets[own.label], body: 'own reply' } });
    expect(ownReply.status()).toBe(201);
  });

  test(`a message template lives only in the org that wrote it · ${label}`, async ({ page }) => {
    const [own, other] = pick(tenants);
    await signInAsTenantActor(page, other.admin);
    const text = `iso canned reply ${other.label} ${stamp}`;
    const res = await page.request.post('/api/admin/message-templates', { data: { translations: { en: text } } });
    expect(res.status()).toBe(201);
    const id = (await res.json()).template.id as string;
    created.messageTemplates.push(id);
    const row = await prisma.messageTemplate.findUniqueOrThrow({ where: { id }, select: { orgId: true } });
    expect(row.orgId, 'stamped with the writer\'s org').toBe(other.org.id);
    // …and it is in the writer's own pool (positive twin).
    const theirs = await page.request.get('/api/admin/message-templates');
    expect(((await theirs.json()).templates as { id: string }[]).map((t) => t.id)).toContain(id);

    await signInAsTenantActor(page, own.admin);
    for (const path of ['/api/admin/message-templates', '/api/message-templates']) {
      const list = await page.request.get(path);
      expect(list.status()).toBe(200);
      const ids = ((await list.json()).templates as { id: string }[]).map((t) => t.id);
      expect(ids, `${path} leaked another tenant's template`).not.toContain(id);
    }
    expect((await page.request.post(`/api/message-templates/${id}/use`)).status()).toBe(404);
    const rename = await page.request.patch('/api/admin/message-templates', { data: { id, translations: { en: 'hijacked' } } });
    expect(rename.status()).toBe(404);
    const retire = await page.request.delete('/api/admin/message-templates', { data: { id } });
    expect(retire.status()).toBe(404);
    const after = await prisma.messageTemplate.findUniqueOrThrow({ where: { id }, select: { title: true, archivedAt: true, useCount: true } });
    expect(after).toEqual({ title: text, archivedAt: null, useCount: 0 });
  });

  test(`a foreign announcement cannot be edited, deleted or its image read · ${label}`, async ({ page }) => {
    const [own, other] = pick(tenants);
    await signInAsTenantActor(page, own.admin);

    const patch = await page.request.patch(`/api/admin/announcements/${announcements[other.label]}`, { data: { text: 'hijacked' } });
    expect(patch.status()).toBe(404);
    const del = await page.request.delete(`/api/admin/announcements/${announcements[other.label]}`);
    expect(del.status()).toBe(404);
    expect((await page.request.get(`/api/announcements/${announcements[other.label]}/image`)).status()).toBe(404);
    const still = await prisma.announcement.findUnique({ where: { id: announcements[other.label] }, select: { text: true } });
    expect(still?.text).toBe(`iso announcement ${other.label} ${stamp}`);

    // Positive twin: the own image is served.
    expect((await page.request.get(`/api/announcements/${announcements[own.label]}/image`)).status()).toBe(200);
  });
}

// Goal templates are an internship (mentorship) surface: a MARKETING org has no
// goal pool at all (#2647), so the isolation is proven one way — the INTERNSHIP
// org's pool never reaches MARKETING, and MARKETING's writes are refused rather
// than landing anywhere.
test('a shared goal template lives only in the INTERNSHIP org that wrote it; MARKETING has no pool', async ({ page }) => {
  const { orgA, orgB } = tenants;
  await signInAsTenantActor(page, orgA.admin);
  const text = `iso shared goal ${orgA.label} ${stamp}`;
  const res = await page.request.post('/api/admin/goal-templates', { data: { translations: { en: text } } });
  expect(res.status()).toBe(201);
  const id = (await res.json()).template.id as string;
  created.goalTemplates.push(id);
  const row = await prisma.projectTaskTemplate.findUniqueOrThrow({ where: { id }, select: { orgId: true } });
  expect(row.orgId).toBe(orgA.org.id);
  // A row planted in the MARKETING org by hand never shows up in A's pool.
  const planted = await prisma.projectTaskTemplate.create({
    data: { projectId: null, orgId: orgB.org.id, title: `iso planted ${stamp}` },
    select: { id: true },
  });
  created.goalTemplates.push(planted.id);
  for (const path of ['/api/admin/goal-templates', '/api/todos/templates']) {
    const ids = ((await (await page.request.get(path)).json()).templates as { id: string }[]).map((t) => t.id);
    expect(ids, `${path} lost the own goal`).toContain(id);
    expect(ids, `${path} leaked another tenant's goal`).not.toContain(planted.id);
  }

  await signInAsTenantActor(page, orgB.admin);
  for (const call of [
    page.request.get('/api/admin/goal-templates'),
    page.request.post('/api/admin/goal-templates', { data: { translations: { en: 'x' } } }),
    page.request.patch('/api/admin/goal-templates', { data: { id, translations: { en: 'hijacked' } } }),
    page.request.delete('/api/admin/goal-templates', { data: { id } }),
  ]) {
    const r = await call;
    expect(r.status(), r.url()).toBe(403);
    expect((await r.json()).code).toBe('capability_unavailable');
  }
  const pool = await page.request.get('/api/todos/templates');
  expect(pool.status()).toBe(200);
  expect(((await pool.json()).templates as { id: string }[]).map((t) => t.id)).not.toContain(id);
  expect(await prisma.projectTaskTemplate.findUniqueOrThrow({ where: { id }, select: { title: true, archivedAt: true } }))
    .toEqual({ title: text, archivedAt: null });
});

test('the MARKETING documents page offers none of the internship built-ins', { tag: '@smoke' }, async ({ page }) => {
  const { orgA, orgB } = tenants;
  // Positive twin first: an INTERNSHIP admin sees the curated library.
  await signInAsTenantActor(page, orgA.admin);
  await gotoSettled(page, '/admin/documents');
  await expect(page.getByTestId('tpl-cv')).toBeVisible();

  await signInAsTenantActor(page, orgB.admin);
  await gotoSettled(page, '/admin/documents');
  // The page itself renders (uploads stay a MARKETING feature) …
  await expect(page.locator('h1').first()).toBeVisible();
  // … without the internship career documents.
  await expect(page.getByTestId('templates-library')).toHaveCount(0);
  await expect(page.getByTestId('tpl-cv')).toHaveCount(0);
  await expect(page.getByTestId('tpl-internship-report')).toHaveCount(0);
});

test('a system activity entry (no org) is the default org\'s, never another tenant\'s', async ({ page }) => {
  const action = `iso.system.${stamp}`;
  const row = await prisma.activityLog.create({ data: { action, detail: 'no actor, no org' }, select: { id: true } });
  try {
    await signInAsTenantActor(page, tenants.orgB.admin);
    const res = await page.request.get(`/api/admin/activity?action=${encodeURIComponent(action)}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).items, 'a NULL-org row leaked to the MARKETING tenant').toEqual([]);
  } finally {
    await prisma.activityLog.deleteMany({ where: { id: row.id } });
  }
});
