import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';
import { seedTwoTenants, signInAsTenantActor, putOnWorld, TENANT_PASSWORD, type TwoTenants } from './helpers/tenants';

/**
 * "Tell the admins" means the admins OF THAT ORG (#2542) — with
 * MT_ENFORCE_ISOLATION **off**, the state of every deployment.
 *
 * Measured before the fix: every admin fan-out in the tree read
 * `user.findMany({ where: { role: 'ADMIN', isActive: true } })` with no org at
 * all, so a SaleVali (MARKETING) admin's bell filled with the InternCRM
 * (INTERNSHIP) tenant's sign-ups, mentorship requests and mentor applications,
 * and the other way round. The recipient list is now `tenantAdminIds(orgId)` /
 * `tenantAdminWhere(orgId)` (src/lib/tenantAdmins.ts): the subject's own org,
 * with a NULL-org admin counted as the DEFAULT org's.
 *
 * Three orgs take part, so every direction is covered: the DEFAULT org (the
 * open sign-up and the public mentor application land there; its admin is
 * seeded with a NULL org on purpose, the backfill rule), an INTERNSHIP org A
 * and a MARKETING org B. Every exclusion has its positive twin — the org's own
 * admin DID get the row — or a fan-out that notified nobody would pass.
 *
 * Asked of the database (Notification rows), not of the UI: the bell renders
 * whatever rows exist, so the rows are the leak.
 */

let tenants: TwoTenants;
let defaultAdmin: { id: string; email: string };
const emails: string[] = [];

test.beforeAll(async () => {
  tenants = await seedTwoTenants({ verticalA: 'INTERNSHIP', verticalB: 'MARKETING' });
  const email = uniqueEmail('fanout-default-admin');
  emails.push(email);
  // No org on purpose: a NULL-org admin is the default org's (orgWhere).
  const user = await seedUser(email, TENANT_PASSWORD, 'ADMIN', 'Fanout Default Admin');
  defaultAdmin = { id: user.id, email };
});

test.afterAll(async () => {
  await prisma.mentorApplication.deleteMany({ where: { email: { in: emails } } });
  await prisma.mentorshipRequest.deleteMany({ where: { mentee: { email: { in: emails } } } });
  for (const email of emails) await cleanupByEmail(email);
  await tenants?.cleanup();
});

/** Notification rows of `type` (prefix) for the given user since `since`. */
async function count(userId: string, typePrefix: string, since: Date): Promise<number> {
  return prisma.notification.count({ where: { userId, type: { startsWith: typePrefix }, createdAt: { gte: since } } });
}

async function freshMentee(orgId: string, label: string): Promise<{ id: string; email: string }> {
  const email = uniqueEmail(`fanout-${label}-mentee`);
  emails.push(email);
  const user = await seedUser(email, TENANT_PASSWORD, 'MENTEE', `Fanout ${label} Mentee`, orgId);
  // The onboarding gate (#591): profile basics + a CV.
  await prisma.user.update({ where: { id: user.id }, data: { university: 'Iso University', skills: ['React'] } });
  const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'));
  await prisma.cvFile.create({
    data: { userId: user.id, filename: 'cv.pdf', contentType: 'application/pdf', size: pdf.length, data: pdf },
  });
  return { id: user.id, email };
}

test('a mentorship request in org A notifies only org A\'s admins', { tag: '@smoke' }, async ({ page }) => {
  const since = new Date(Date.now() - 1000);
  const { orgA, orgB } = tenants;
  const mentee = await freshMentee(orgA.org.id, 'a');

  await putOnWorld(page, 'INTERNSHIP');
  await signInAsFreshUser(page, mentee.email, TENANT_PASSWORD, '/portal');
  const res = await page.request.post('/api/mentorship-requests', { data: { message: 'Isolation probe.' } });
  expect(res.status()).toBe(201);

  // Positive twin: org A's own admin got the bell row.
  expect(await count(orgA.admin.id, 'mentorship_request.new', since)).toBe(1);
  // Neither the MARKETING org's admin nor the default org's did.
  expect(await count(orgB.admin.id, 'mentorship_request', since), 'MARKETING admin was told about org A').toBe(0);
  expect(await count(defaultAdmin.id, 'mentorship_request', since), 'default-org admin was told about org A').toBe(0);
});

test('an open sign-up (default org) notifies only the default org\'s admins', { tag: '@smoke' }, async ({ request }) => {
  const since = new Date(Date.now() - 1000);
  const { orgA, orgB } = tenants;
  const email = uniqueEmail('fanout-signup');
  emails.push(email);

  const res = await request.post('/api/register', {
    data: { email, password: TENANT_PASSWORD, fullName: 'Fanout Signup', consent: true },
  });
  expect(res.status()).toBe(201);

  expect(await count(defaultAdmin.id, 'signup.', since), 'the NULL-org (default) admin must hear of it').toBe(1);
  expect(await count(orgA.admin.id, 'signup.', since), 'another INTERNSHIP org\'s admin was told').toBe(0);
  expect(await count(orgB.admin.id, 'signup.', since), 'the MARKETING admin was told').toBe(0);
});

test('an invited sign-up\'s duplicate warning reaches only its own org\'s admins', async ({ request }) => {
  const since = new Date(Date.now() - 1000);
  const { orgA, orgB } = tenants;
  // The invitation's own address (an addressed invitation must be used by it);
  // the fixture's cleanup removes it.
  const email = orgA.invitation.email;

  // Org A's own MENTEE invitation, registering under the name of org A's
  // existing mentee — the duplicate post-check fires for org A.
  const res = await request.post('/api/register', {
    data: { token: orgA.invitation.token, email, password: TENANT_PASSWORD, fullName: orgA.mentee.fullName, consent: true },
  });
  expect(res.status()).toBe(201);
  expect((await res.json()).user.orgId).toBe(orgA.org.id);

  // Fire-and-forget on the server: poll for the positive twin first.
  await expect.poll(() => count(orgA.admin.id, 'duplicate.suspected', since), { timeout: 10_000 }).toBe(1);
  expect(await count(orgB.admin.id, 'duplicate.suspected', since)).toBe(0);
  expect(await count(defaultAdmin.id, 'duplicate.suspected', since)).toBe(0);
});

test('a public mentor application notifies the default org\'s admins only, and lists only there', async ({ page, request }) => {
  const since = new Date(Date.now() - 1000);
  const { orgA, orgB } = tenants;
  const email = uniqueEmail('fanout-mentor-app');
  emails.push(email);

  const res = await request.post('/api/mentor-applications', { data: { fullName: 'Fanout Applicant', email } });
  expect(res.status()).toBe(200);
  const row = await prisma.mentorApplication.findFirstOrThrow({ where: { email }, select: { id: true, orgId: true } });

  expect(await count(defaultAdmin.id, 'mentor_application.new', since)).toBe(1);
  expect(await count(orgA.admin.id, 'mentor_application', since)).toBe(0);
  expect(await count(orgB.admin.id, 'mentor_application', since)).toBe(0);

  const listIds = async (p: Page) => {
    const r = await p.request.get('/api/mentor-applications?page=1');
    expect(r.status()).toBe(200);
    return ((await r.json()).items as { id: string }[]).map((i) => i.id);
  };

  // The default org's admin sees it...
  await putOnWorld(page, 'INTERNSHIP');
  await signInAsFreshUser(page, defaultAdmin.email, TENANT_PASSWORD, '/admin');
  expect(await listIds(page)).toContain(row.id);

  // ...another INTERNSHIP org's admin neither lists nor opens it...
  await signInAsTenantActor(page, orgA.admin);
  expect(await listIds(page), 'org A\'s admin listed the default org\'s application').not.toContain(row.id);
  expect((await page.request.get(`/api/mentor-applications/${row.id}`)).status()).toBe(404);

  // ...and the MARKETING vertical has no mentor recruiting at all.
  await signInAsTenantActor(page, orgB.admin);
  const gated = await page.request.get('/api/mentor-applications');
  expect(gated.status()).toBe(403);
  expect((await gated.json()).code).toBe('capability_unavailable');
});

test('the only admin of an org cannot delete themselves because another org has admins', async ({ page }) => {
  const { orgB } = tenants;
  await signInAsTenantActor(page, orgB.admin);
  const res = await page.request.delete('/api/account', { data: { currentPassword: TENANT_PASSWORD } });
  expect(res.status()).toBe(400);
  expect(await prisma.user.count({ where: { id: orgB.admin.id } })).toBe(1);
});
