import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setDefaultOrgSetting } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { E2E_HIBP_MOCK_PORT } from '../playwright.config';

// The password policy (#1544): the rules are settings, read by the server for
// register/reset/account and by the forms through GET /api/auth/password-policy,
// so the browser never accepts what the API refuses (#1215); and new passwords
// are screened against Have I Been Pwned by k-anonymity — against the local
// stub in e2e/support/hibp-mock.mjs here — failing OPEN when the service is
// down. The server-side contract is @smoke: a weakening of the rule or a
// screening that blocks sign-up during an outage are both things the PR gate
// must catch.

const HIBP = `http://127.0.0.1:${E2E_HIBP_MOCK_PORT}`;
const PASS = 'PolicyPass123';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function hibpReset(request: APIRequestContext) {
  await request.post(`${HIBP}/__reset`);
}
async function hibpOutage(request: APIRequestContext, on: boolean) {
  await request.post(`${HIBP}/__outage`, { data: { on } });
}
async function hibpRequests(request: APIRequestContext): Promise<Array<{ path: string; prefix: string; padding: string | null }>> {
  return (await (await request.get(`${HIBP}/__received`)).json()).requests;
}

/** POST /api/register as a brand-new mentee with `password`; returns the response and the address used. */
async function registerWith(request: APIRequestContext, password: string, tag: string) {
  const email = uniqueEmail(`pwpolicy-${tag}`);
  const res = await request.post('/api/register', {
    headers: freshIp(`pwpolicy-${tag}`),
    data: { email, password, fullName: 'Policy Tester', consent: true },
  });
  return { res, email };
}

/** Put the default org's policy back to the code default. */
async function restoreDefaultPolicy() {
  await setDefaultOrgSetting('passwordMinLength', '8');
  await setDefaultOrgSetting('passwordRequireUpper', 'true');
  await setDefaultOrgSetting('passwordRequireLower', 'true');
  await setDefaultOrgSetting('passwordRequireDigit', 'false');
  await setDefaultOrgSetting('passwordRequireSymbol', 'false');
  await setDefaultOrgSetting('breachedPasswordCheck', 'true');
}

test('the server enforces the org policy, refuses a breached password by k-anonymity, and fails open on an HIBP outage', { tag: '@smoke' }, async ({ request }) => {
  const created: string[] = [];
  try {
    await restoreDefaultPolicy();
    await hibpReset(request);

    // The policy endpoint, anonymous: the default rule, in display order.
    const policy = await (await request.get('/api/auth/password-policy')).json();
    expect(policy.policy).toEqual({ minLength: 8, requireUpper: true, requireLower: true, requireDigit: false, requireSymbol: false });
    expect(policy.rules).toEqual(['min_length', 'upper', 'lower']);
    expect(policy.breachCheck).toBe(true);

    // 1. A password that misses a rule is refused with the rule named.
    const weak = await registerWith(request, 'weakpass', 'weak');
    expect(weak.res.status()).toBe(400);
    const weakBody = await weak.res.json();
    expect(weakBody.code).toBe('password_policy');
    expect(weakBody.failed).toEqual(['upper']);
    expect(weakBody.error).toMatch(/uppercase/);
    // Nothing was sent to HIBP for a password the policy already refused.
    expect(await hibpRequests(request)).toHaveLength(0);

    // 2. A policy-compliant password that is in the breach corpus is refused,
    //    and the receiver saw exactly one 5-character prefix — never the hash.
    const breached = await registerWith(request, 'Password123', 'breached');
    expect(breached.res.status()).toBe(400);
    expect((await breached.res.json()).code).toBe('password_breached');
    const seen = await hibpRequests(request);
    expect(seen).toHaveLength(1);
    expect(seen[0].prefix).toMatch(/^[0-9A-F]{5}$/);
    expect(seen[0].padding).toBe('true');
    expect(seen[0].path.length).toBe('/range/'.length + 5);
    expect(await prisma.user.count({ where: { email: breached.email } })).toBe(0);

    // 3. The same breached password during an outage is ACCEPTED: a third-party
    //    outage never blocks a sign-up (fail open).
    await hibpOutage(request, true);
    const open = await registerWith(request, 'Password123', 'outage');
    expect(open.res.ok()).toBeTruthy();
    created.push(open.email);
    expect(await prisma.user.count({ where: { email: open.email } })).toBe(1);
    await hibpOutage(request, false);

    // 4. A stricter policy takes effect on the next registration, no redeploy.
    await setDefaultOrgSetting('passwordMinLength', '12');
    await setDefaultOrgSetting('passwordRequireDigit', 'true');
    const strict = await (await request.get('/api/auth/password-policy')).json();
    expect(strict.policy.minLength).toBe(12);
    expect(strict.rules).toEqual(['min_length', 'upper', 'lower', 'digit']);
    const short = await registerWith(request, 'Shortpass1', 'short');
    expect(short.res.status()).toBe(400);
    expect((await short.res.json()).failed).toEqual(['min_length']);
    const noDigit = await registerWith(request, 'LongerPassword', 'nodigit');
    expect((await noDigit.res.json()).failed).toEqual(['digit']);
    const fine = await registerWith(request, 'LongerPassword9', 'fine');
    expect(fine.res.ok()).toBeTruthy();
    created.push(fine.email);

    // 5. The screening can be switched off: the breached password passes with the stub up.
    await setDefaultOrgSetting('breachedPasswordCheck', 'false');
    await hibpReset(request);
    const unscreened = await registerWith(request, 'Password123Long', 'off');
    expect(unscreened.res.ok()).toBeTruthy();
    created.push(unscreened.email);
    expect(await hibpRequests(request)).toHaveLength(0);
  } finally {
    await restoreDefaultPolicy();
    await hibpOutage(request, false).catch(() => {});
    for (const email of created) await cleanupByEmail(email);
  }
});

test('the sign-up form lists the org’s rules and refuses a non-compliant password before it reaches the server', async ({ page }) => {
  try {
    await setDefaultOrgSetting('passwordMinLength', '12');
    await setDefaultOrgSetting('passwordRequireDigit', 'true');
    await page.goto('/auth/register');
    const rules = page.getByTestId('password-rules');
    await expect(rules).toContainText('12 characters');
    await expect(page.getByTestId('password-rule-digit')).toBeVisible();
    await expect(page.getByTestId('password-rule-symbol')).toHaveCount(0);

    // Typing ticks the rules the value satisfies.
    await page.fill('input[name="password"]', 'Shortpass1');
    await expect(page.getByTestId('password-rule-upper')).toHaveAttribute('data-satisfied', '1');
    await expect(page.getByTestId('password-rule-digit')).toHaveAttribute('data-satisfied', '1');
    await expect(page.getByTestId('password-rule-min_length')).toHaveAttribute('data-satisfied', '0');

    // Submitting shows the rule in the form; no registration request is made.
    let posted = false;
    page.on('request', (r) => { if (r.url().includes('/api/register') && r.method() === 'POST') posted = true; });
    await page.fill('input[name="email"]', uniqueEmail('pwpolicy-ui'));
    await page.fill('input[name="fullName"]', 'Policy UI');
    await page.fill('input[name="confirmPassword"]', 'Shortpass1');
    await page.getByLabel(/consent|I agree|accept/i).first().check().catch(() => {});
    await page.click('button[type="submit"]');
    await expect(page.getByText(/12 characters/).first()).toBeVisible();
    expect(posted).toBe(false);
  } finally {
    await restoreDefaultPolicy();
  }
});

test('an admin changes the policy on /admin/settings; a minimum under the floor is refused', async ({ page }) => {
  const adminEmail = uniqueEmail('pwpolicy-admin');
  await seedUser(adminEmail, PASS, 'ADMIN', 'Policy Admin');
  try {
    await restoreDefaultPolicy();
    await signInAndSettle(page, adminEmail, PASS, '/admin');

    const tooLow = await page.request.put('/api/admin/settings', { data: { passwordMinLength: '7' } });
    expect(tooLow.status()).toBe(400);
    expect((await tooLow.json()).field).toBe('passwordMinLength');

    const ok = await page.request.put('/api/admin/settings', { data: { passwordMinLength: '10', passwordRequireSymbol: 'true' } });
    expect(ok.ok()).toBeTruthy();
    const policy = await (await page.request.get('/api/auth/password-policy')).json();
    expect(policy.policy.minLength).toBe(10);
    expect(policy.rules).toContain('symbol');

    // The controls render the stored values.
    // gotoSettled: /admin/settings streams its Suspense copy, and a bare goto
    // let the testid resolve to both copies (strict-mode violation, e2e-full).
    await gotoSettled(page, '/admin/settings');
    await expect(page.getByTestId('password-min-length')).toHaveValue('10');
    await expect(page.getByTestId('password-require-symbol')).toBeChecked();
    await expect(page.getByTestId('password-require-digit')).not.toBeChecked();
  } finally {
    await restoreDefaultPolicy();
    await cleanupByEmail(adminEmail);
  }
});
