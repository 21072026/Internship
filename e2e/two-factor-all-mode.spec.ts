import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  prisma,
  seedUser,
  cleanupByEmail,
  uniqueEmail,
  setDefaultOrgSetting,
  seedCustomPipelineOrg,
  cleanupCustomPipelineOrg,
} from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';

/**
 * `require2fa = 'all'` and the enrolment coverage report (#1644).
 *
 * The first test is @smoke on purpose: a policy that can hold EVERY account at
 * the setup gate is exactly the kind of change the PR gate must catch — both
 * ways. A shell that lost its gate makes "all" a false claim; a gate that fires
 * under `off` locks a tenant out.
 *
 * The policy is the default org's row (what the settings form writes since
 * #2628) and the CI database is shared across tests, so every test restores it
 * to 'off' no matter what — see e2e/two-factor-enforcement.spec.ts.
 */

const PW = 'AllMode123!';

async function setPolicy(value: string) {
  await setDefaultOrgSetting('require2fa', value);
}

async function setOrgPolicy(orgId: string, value: string) {
  const existing = await prisma.setting.findFirst({ where: { orgId, key: 'require2fa' } });
  if (existing) await prisma.setting.update({ where: { id: existing.id }, data: { value } });
  else await prisma.setting.create({ data: { orgId, key: 'require2fa', value } });
}

async function defaultOrgPolicy(): Promise<string | undefined> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: 'default' }, select: { id: true } });
  return (await prisma.setting.findFirst({ where: { orgId: org.id, key: 'require2fa' } }))?.value;
}

/**
 * Where a signed-in GET for `path` lands: the redirect target's pathname, the
 * path itself when it is served, else the status. The gate is a server-side
 * `redirect()` in the role layout, so the answer is in the first response —
 * no browser needed, and no client-side check could fake it.
 */
async function landing(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.get(path, { maxRedirects: 0 });
  const loc = res.headers()['location'];
  if (loc) return new URL(loc, 'http://placeholder.invalid').pathname;
  return res.ok() ? path : `status:${res.status()}`;
}

test.afterAll(async () => {
  await setPolicy('off');
  await prisma.$disconnect();
});

test(
  "'all' holds a mentee, a company login and a source login at the setup gate; 'off' lets them through",
  { tag: '@smoke' },
  async ({ playwright, baseURL }) => {
    const people = [
      { role: 'MENTEE' as const, home: '/portal', email: uniqueEmail('all-mentee') },
      { role: 'COMPANY' as const, home: '/company', email: uniqueEmail('all-company') },
      { role: 'SOURCE' as const, home: '/source', email: uniqueEmail('all-source') },
    ];
    const contexts: APIRequestContext[] = [];
    try {
      await setPolicy('off');
      for (const p of people) {
        await seedUser(p.email, PW, p.role, `All ${p.role}`);
        const ctx = await playwright.request.newContext({ baseURL });
        contexts.push(ctx);
        expect((await signInViaApi(ctx, p.email, PW)).ok, `${p.role} sign-in`).toBe(true);
        expect(await landing(ctx, p.home), `${p.role} under off`).toBe(p.home);
      }

      await setPolicy('all');
      for (const [i, p] of people.entries()) {
        expect(await landing(contexts[i], p.home), `${p.role} under all`).toBe('/security-setup');
        // And the gate page itself is served to them, not bounced back home.
        expect(await landing(contexts[i], '/security-setup'), `${p.role} gate page`).toBe('/security-setup');
      }

      // Relaxing the policy lets everyone back in without enrolling.
      await setPolicy('off');
      for (const [i, p] of people.entries()) {
        expect(await landing(contexts[i], p.home), `${p.role} relaxed`).toBe(p.home);
      }
    } finally {
      await setPolicy('off');
      for (const ctx of contexts) await ctx.dispose();
      for (const p of people) await cleanupByEmail(p.email);
    }
  }
);

test('two orgs hold different policies, and the coverage report is org-scoped and admin-only', async ({ playwright, baseURL }) => {
  const seeded = await seedCustomPipelineOrg('tfa-cov', PW);
  const [adminEmail, mentorEmail, menteeEmail] = seeded.emails;
  const outsiderEmail = uniqueEmail('tfa-outsider');
  const admin = await playwright.request.newContext({ baseURL });
  const mentee = await playwright.request.newContext({ baseURL });
  const outsider = await playwright.request.newContext({ baseURL });
  const anon = await playwright.request.newContext({ baseURL });
  try {
    await setPolicy('off');
    await seedUser(outsiderEmail, PW, 'MENTEE', 'Outside Mentee');
    await setOrgPolicy(seeded.org.id, 'all');

    expect((await signInViaApi(mentee, menteeEmail, PW)).ok).toBe(true);
    expect((await signInViaApi(outsider, outsiderEmail, PW)).ok).toBe(true);
    expect((await signInViaApi(admin, adminEmail, PW)).ok).toBe(true);

    // Each person is judged by THEIR org's policy.
    expect(await landing(mentee, '/portal')).toBe('/security-setup');
    expect(await landing(outsider, '/portal')).toBe('/portal');

    // The report is admin-only: 401 without a session, 403 for a signed-in non-admin.
    expect((await anon.get('/api/admin/2fa-coverage')).status()).toBe(401);
    expect((await mentee.get('/api/admin/2fa-coverage')).status()).toBe(403);

    const res = await admin.get('/api/admin/2fa-coverage');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.policy).toBe('all');
    type Row = { role: string; total: number; enabled: number; percentage: number };
    const byRole = Object.fromEntries((body.roles as Row[]).map((r) => [r.role, r]));
    // Exactly this org's three accounts — the outsider and every other test's
    // users live in the default org and must not leak into these numbers.
    expect(byRole.ADMIN).toMatchObject({ total: 1, enabled: 0, percentage: 0 });
    expect(byRole.MENTOR).toMatchObject({ total: 1, enabled: 0, percentage: 0 });
    expect(byRole.MENTEE).toMatchObject({ total: 1, enabled: 0, percentage: 0 });
    expect(byRole.COMPANY).toMatchObject({ total: 0, enabled: 0, percentage: 100 });
    expect(byRole.SOURCE).toMatchObject({ total: 0, enabled: 0, percentage: 100 });
    expect(body.overall).toMatchObject({ total: 3, enabled: 0, percentage: 0 });
    expect(body.inScope).toMatchObject({ total: 3, enabled: 0 });
    expect(body.missing.total).toBe(3);
    const listed = (body.missing.items as { email: string }[]).map((u) => u.email).sort();
    expect(listed).toEqual([adminEmail, mentorEmail, menteeEmail].sort());
    expect(listed).not.toContain(outsiderEmail);

    // Enrolment moves the numbers: one mentor with 2FA on.
    await prisma.user.updateMany({ where: { email: mentorEmail }, data: { twoFactorEnabled: true } });
    const after = await (await admin.get('/api/admin/2fa-coverage')).json();
    expect((after.roles as Row[]).find((r) => r.role === 'MENTOR')).toMatchObject({ total: 1, enabled: 1, percentage: 100 });
    expect(after.missing.total).toBe(2);

    // The CSV export: the same list, as a file.
    const csv = await admin.get('/api/admin/2fa-coverage?format=csv');
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    const lines = (await csv.text()).replace(/^﻿/, '').trim().split('\n');
    expect(lines[0]).toBe('"name","email","role","last_sign_in"');
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain(adminEmail);
    expect(lines.join('\n')).not.toContain(mentorEmail);
  } finally {
    await setPolicy('off');
    await prisma.setting.deleteMany({ where: { orgId: seeded.org.id } });
    for (const ctx of [admin, mentee, outsider, anon]) await ctx.dispose();
    await cleanupByEmail(outsiderEmail);
    await cleanupCustomPipelineOrg(seeded.org.id, seeded.emails);
  }
});

test('switching to a stricter mode shows the coverage and asks for confirmation before it saves', async ({ page }) => {
  const adminEmail = uniqueEmail('tfa-strict-admin');
  await seedUser(adminEmail, PW, 'ADMIN', 'Strict Admin');
  // The admin counts as enrolled so the `all` policy they are about to save
  // does not hold THEM at the gate; a null secret means sign-in asks no code.
  await prisma.user.updateMany({ where: { email: adminEmail }, data: { twoFactorEnabled: true, twoFactorSecret: null } });
  try {
    await setPolicy('off');
    await signInAndSettle(page, adminEmail, PW, '/admin');
    await gotoSettled(page, '/admin/settings');
    const form = page.getByTestId('settings-form');
    await expect(form).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    await expect(page.getByTestId('two-factor-coverage')).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    await expect(page.getByTestId('two-factor-coverage-role-MENTEE')).toBeVisible();

    await page.locator('#require-2fa').selectOption('all');
    // The line under the select is the coverage of the SELECTED mode.
    await expect(page.getByTestId('two-factor-scope-coverage')).toContainText('%');

    // Submit: a stricter switch is confirmed first, and cancelling saves nothing.
    const submit = form.locator('button[type="submit"]').first();
    await submit.click();
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('#1542');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(await defaultOrgPolicy()).toBe('off');

    // Confirming applies it.
    await submit.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply the stricter policy' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Changes saved')).toBeVisible({ timeout: 10_000 });
    expect(await defaultOrgPolicy()).toBe('all');

    // Relaxing it back asks nothing.
    await page.locator('#require-2fa').selectOption('off');
    await submit.click();
    await expect(dialog).toBeHidden();
    await expect.poll(defaultOrgPolicy, { timeout: 10_000 }).toBe('off');
  } finally {
    await setPolicy('off');
    await cleanupByEmail(adminEmail);
  }
});
