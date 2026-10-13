import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Tenant provisioning wizard (#2065): identity → plan → branding → starter
// pack + first admin → review → one create, applied server-side in one
// transaction (src/lib/orgProvisioning.ts).

const PASSWORD = 'WizardPass123!';
const slugs: string[] = [];
const emails: string[] = [];

test.afterAll(async () => {
  for (const slug of slugs) {
    const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    if (!org) continue;
    // Same wipe as org-starter-pack.spec.ts: the rows whose FK does not cascade first.
    await prisma.invitationToken.deleteMany({ where: { orgId: org.id } });
    await prisma.evaluationTemplate.deleteMany({ where: { orgId: org.id } });
    await prisma.projectTaskTemplate.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
  for (const e of emails) await cleanupByEmail(e);
});

async function superAdmin() {
  const email = uniqueEmail('wizard-super');
  emails.push(email);
  const u = await seedUser(email, PASSWORD, 'ADMIN', 'Wizard Super');
  await prisma.user.update({ where: { id: u.id }, data: { isSuperAdmin: true } });
  return email;
}

test('a super admin walks the wizard to a planned organization with its first admin invited', { tag: '@smoke' }, async ({ page }) => {
  const email = await superAdmin();
  const stamp = Date.now();
  const name = `Wizard Org ${stamp}`;
  const slug = `wizard-org-${stamp}`;
  const adminEmail = `first-admin-${stamp}@example.com`;
  slugs.push(slug);

  await signInAndSettle(page, email, PASSWORD, '/admin');
  await page.goto('/admin/organizations/new');
  await expect(page.getByTestId('org-wizard-step-1')).toBeVisible();

  // Identity: the slug follows the name and is reported free before submit.
  await page.getByTestId('org-wizard-name').fill(name);
  await expect(page.getByTestId('org-wizard-slug')).toHaveValue(slug);
  await expect(page.getByTestId('org-wizard-slug-status')).toHaveAttribute('data-state', 'available');
  await page.getByTestId('org-wizard-next').click();

  // Plan — and a reload keeps both the step and the values.
  await expect(page.getByTestId('org-wizard-step-2')).toBeVisible();
  await page.getByTestId('org-wizard-plan-PRO').click();
  await page.reload();
  await expect(page.getByTestId('org-wizard-step-2')).toBeVisible();
  await expect(page.getByTestId('org-wizard-plan-PRO')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('org-wizard-next').click();

  // Branding is an ENTERPRISE feature (#1742): on PRO the step says so.
  await expect(page.getByTestId('org-wizard-branding-locked')).toBeVisible();
  await page.getByTestId('org-wizard-next').click();

  // Starter pack (on by default) and the first administrator.
  await expect(page.getByTestId('org-wizard-starter')).toBeChecked();
  await page.getByTestId('org-wizard-admin-email').fill(adminEmail);
  await page.getByTestId('org-wizard-next').click();

  // Review & create.
  await expect(page.getByTestId('org-wizard-review')).toContainText(name);
  await page.getByTestId('org-wizard-create').click();
  await expect(page.getByTestId('org-wizard-done')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('org-wizard-register-url')).toContainText('/auth/register?token=');

  const org = await prisma.organization.findUnique({ where: { slug } });
  expect(org).toMatchObject({ name, plan: 'PRO', vertical: 'INTERNSHIP', brandName: null });
  // The starter pack landed in the same create.
  expect(await prisma.pipelineStage.count({ where: { orgId: org!.id } })).toBeGreaterThan(0);
  expect(await prisma.stageSla.count({ where: { orgId: org!.id } })).toBeGreaterThan(0);
  expect(await prisma.evaluationTemplate.count({ where: { orgId: org!.id } })).toBe(2);
  // And the first admin's invitation belongs to the NEW organization.
  const invite = await prisma.invitationToken.findFirst({ where: { orgId: org!.id } });
  expect(invite).toMatchObject({ email: adminEmail, role: 'ADMIN', used: false });
});

test('the create route re-checks the slug, the plan feature and the address, and leaves nothing behind on refusal', async ({ page }) => {
  const email = await superAdmin();
  const stamp = Date.now();
  const slug = `wizard-api-${stamp}`;
  slugs.push(slug);
  await signInAndSettle(page, email, PASSWORD, '/admin');

  const ok = await page.request.post('/api/admin/organizations', {
    data: { name: `Wizard API ${stamp}`, slug, vertical: 'INTERNSHIP', plan: 'ENTERPRISE', brandName: 'Acme', brandColor: '#2563eb', starterPack: false },
  });
  expect(ok.status()).toBe(201);
  const body = await ok.json();
  expect(body.starterPack).toBeNull();
  expect(body.invitation).toBeNull();
  expect((await prisma.organization.findUnique({ where: { slug } }))?.brandName).toBe('Acme');

  // The availability endpoint and the create agree.
  expect((await (await page.request.get(`/api/admin/organizations/slug-availability?slug=${slug}`)).json()).available).toBe(false);
  expect((await (await page.request.get(`/api/admin/organizations/slug-availability?slug=${slug}-free`)).json()).available).toBe(true);
  const taken = await page.request.post('/api/admin/organizations', { data: { name: 'Dup', slug, vertical: 'INTERNSHIP' } });
  expect(taken.status()).toBe(409);
  expect((await taken.json()).code).toBe('slug_taken');

  // Branding on a plan without it: refused, and no organization is left.
  const lockedSlug = `wizard-locked-${stamp}`;
  const locked = await page.request.post('/api/admin/organizations', {
    data: { name: 'Locked', slug: lockedSlug, vertical: 'INTERNSHIP', plan: 'FREE', brandName: 'Nope' },
  });
  expect(locked.status()).toBe(403);
  expect((await locked.json()).code).toBe('feature_locked');
  expect(await prisma.organization.count({ where: { slug: lockedSlug } })).toBe(0);

  // An address that is already an account in this product.
  const takenEmailSlug = `wizard-email-${stamp}`;
  const dupAdmin = await page.request.post('/api/admin/organizations', {
    data: { name: 'Email', slug: takenEmailSlug, vertical: 'INTERNSHIP', firstAdminEmail: email },
  });
  expect(dupAdmin.status()).toBe(409);
  expect((await dupAdmin.json()).code).toBe('email_taken_in_world');
  expect(await prisma.organization.count({ where: { slug: takenEmailSlug } })).toBe(0);
});

test('a tenant admin sees the wizard refuse, and cannot ask for slugs', async ({ page }) => {
  const email = uniqueEmail('wizard-tenant');
  emails.push(email);
  await seedUser(email, PASSWORD, 'ADMIN', 'Wizard Tenant');
  await signInAndSettle(page, email, PASSWORD, '/admin');
  await page.goto('/admin/organizations/new');
  await expect(page.getByTestId('org-wizard-forbidden')).toBeVisible();
  expect((await page.request.get('/api/admin/organizations/slug-availability?slug=anything')).status()).toBe(403);
  expect((await page.request.post('/api/admin/organizations', { data: { name: 'X', vertical: 'INTERNSHIP' } })).status()).toBe(403);
});
