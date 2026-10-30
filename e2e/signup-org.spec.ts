// Self-serve tenant signup (#1749): POST /api/public/signup/org creates an
// organization, its first ADMIN, a consent row and a Subscription in ONE
// transaction, never returns a session, and is not an enumeration oracle. The
// e2e server runs with SELF_SERVE_SIGNUP=true (playwright.config.ts); the OFF
// state — 503 before any write — is pinned by scripts/test/self-serve-signup.test.mjs.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, cleanupByEmail, seedUser, uniqueEmail } from './helpers/db';
import { asHost, MARKETING_HOST } from './helpers/auth';
import { floodIp, freshIp } from './helpers/rateLimit';

const PASSWORD = 'SelfServe-Signup-2026!';
const emails: string[] = [];
const orgIds = new Set<string>();

async function dropOrg(orgId: string) {
  // The starter pack (#2066) seeds the org's own configuration; nothing else
  // references it, so this is the whole tenant.
  await prisma.invitationToken.deleteMany({ where: { orgId } });
  await prisma.evaluationTemplate.deleteMany({ where: { orgId } });
  await prisma.projectTaskTemplate.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
}

test.afterAll(async () => {
  for (const e of emails) await cleanupByEmail(e);
  for (const id of orgIds) await dropOrg(id);
});

function body(email: string, orgName: string, extra: Record<string, unknown> = {}) {
  return { orgName, fullName: 'Self Serve Admin', email, password: PASSWORD, consent: true, locale: 'en', timezone: 'Europe/Berlin', ...extra };
}

async function signup(request: APIRequestContext, data: Record<string, unknown>, headers: Record<string, string> = {}) {
  return request.post('/api/public/signup/org', { data, headers: { ...freshIp('signup-org'), ...headers } });
}

test('signup creates org + unverified ADMIN + consent + subscription; verify admits it; the default org is untouched', { tag: '@smoke' }, async ({ page, request }) => {
  const email = uniqueEmail('selfserve-admin');
  emails.push(email);
  const defaultOrg = await prisma.organization.findUnique({ where: { slug: 'default' } });
  const defaultUsersBefore = defaultOrg ? await prisma.user.count({ where: { orgId: defaultOrg.id } }) : 0;

  const res = await signup(request, body(email, `Acme Sales ${Date.now()}`));
  expect(res.status()).toBe(201);
  const json = await res.json();
  expect(json.ok).toBe(true);
  expect(typeof json.orgSlug).toBe('string');
  // Never a session, never an id.
  expect(res.headers()['set-cookie'] ?? '').not.toMatch(/session-token/);
  expect(JSON.stringify(json)).not.toMatch(/userId|"id"/);

  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: json.orgSlug } });
  orgIds.add(org.id);
  expect(org.plan).toBe('FREE');
  expect(org.vertical).toBe('INTERNSHIP');
  const users = await prisma.user.findMany({ where: { orgId: org.id } });
  expect(users).toHaveLength(1);
  const admin = users[0];
  expect(admin.email).toBe(email);
  // The one account writer raised its event inside the signup transaction (#1998).
  const created = await prisma.domainEvent.findMany({ where: { name: 'user.created', subjectId: admin.id } });
  expect(created.map((e) => e.payload)).toEqual([{ userId: admin.id, role: 'ADMIN', source: 'signup' }]);
  expect(created[0].orgId).toBe(org.id);
  expect(admin.role).toBe('ADMIN');
  expect(admin.isActive).toBe(false);
  expect(admin.emailVerified).toBe(false);
  expect(await prisma.userConsent.count({ where: { userId: admin.id } })).toBe(1);
  expect(await prisma.subscription.count({ where: { orgId: org.id } })).toBe(1);

  // The default org: no new account, no row changed.
  if (defaultOrg) {
    expect(await prisma.user.count({ where: { orgId: defaultOrg.id } })).toBe(defaultUsersBefore);
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: defaultOrg.id } });
    expect(after.updatedAt.getTime()).toBe(defaultOrg.updatedAt.getTime());
  }

  // Sign-in is refused until the address is verified.
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/auth\/signin/);

  const token = await prisma.emailVerificationToken.findFirst({ where: { userId: admin.id, used: false }, orderBy: { createdAt: 'desc' } });
  expect(token).not.toBeNull();
  const verified = await page.request.post('/api/auth/verify-email', { data: { token: token!.token } });
  expect(verified.ok()).toBeTruthy();

  await page.context().clearCookies();
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
});

test('an address already in this product is refused exactly like an unusable name — no oracle, no rows', { tag: '@smoke' }, async ({ request }) => {
  const taken = uniqueEmail('selfserve-taken');
  emails.push(taken);
  await seedUser(taken, PASSWORD, 'MENTEE', 'Existing Person');
  const orgsBefore = await prisma.organization.count();

  const takenRes = await signup(request, body(taken, `Taken Mail ${Date.now()}`));
  // Casing and a different org name change nothing: the address decides.
  const takenAgain = await signup(request, body(taken.toUpperCase(), `Other Name ${Date.now()}`));

  expect(takenRes.status()).toBe(409);
  expect(takenAgain.status()).toBe(409);
  const refusal = await takenRes.json();
  expect(refusal.code).toBe('signup_unavailable');
  expect(await takenAgain.json()).toEqual(refusal);
  // Nothing in the refusal says WHICH input was the problem.
  expect(JSON.stringify(refusal)).not.toMatch(/email|slug|exists|taken/i);
  expect(await prisma.organization.count()).toBe(orgsBefore);
});

test('a slug that is taken gets a suffix instead of turning the visitor away', async ({ request }) => {
  const first = uniqueEmail('selfserve-slug1');
  const second = uniqueEmail('selfserve-slug2');
  emails.push(first, second);
  const name = `Same Name ${Date.now()}`;
  const a = await signup(request, body(first, name));
  const b = await signup(request, body(second, name));
  expect(a.status()).toBe(201);
  expect(b.status()).toBe(201);
  const slugA = (await a.json()).orgSlug as string;
  const slugB = (await b.json()).orgSlug as string;
  for (const slug of [slugA, slugB]) orgIds.add((await prisma.organization.findUniqueOrThrow({ where: { slug } })).id);
  expect(slugB).not.toBe(slugA);
  expect(slugB.startsWith(`${slugA}-`)).toBe(true);
});

test('a failure inside the transaction leaves no organization, user, consent or subscription', { tag: '@smoke' }, async ({ request }) => {
  const email = uniqueEmail('selfserve-rollback');
  emails.push(email);
  const name = `Rollback Org ${Date.now()}`;
  const [orgs, subs, consents, created] = await Promise.all([
    prisma.organization.count(),
    prisma.subscription.count(),
    prisma.userConsent.count(),
    prisma.domainEvent.count({ where: { name: 'user.created' } }),
  ]);

  const res = await signup(request, body(email, name), { 'x-e2e-fail-signup': '1' });
  expect(res.status()).toBe(500);

  expect(await prisma.organization.count()).toBe(orgs);
  expect(await prisma.subscription.count()).toBe(subs);
  expect(await prisma.userConsent.count()).toBe(consents);
  expect(await prisma.user.count({ where: { email } })).toBe(0);
  expect(await prisma.organization.count({ where: { name } })).toBe(0);
  // …and no ghost event: user.created was written through the same
  // transaction (emitInTransaction), so the rollback took it too (#1998).
  expect(await prisma.domainEvent.count({ where: { name: 'user.created' } })).toBe(created);
});

test('a MARKETING host refuses a self-serve signup before any write', { tag: '@smoke' }, async ({ request }) => {
  const email = uniqueEmail('selfserve-mkt');
  const res = await signup(request, body(email, `Marketing Try ${Date.now()}`), asHost(MARKETING_HOST));
  expect(res.status()).toBe(403);
  expect((await res.json()).code).toBe('invitation_required');
  expect(await prisma.user.count({ where: { email } })).toBe(0);
});

test('the sixth signup attempt from one address within the hour is rate-limited', { tag: '@smoke' }, async ({ request }) => {
  const ip = floodIp('signup-org-flood');
  // Invalid bodies spend the bucket too: the limit runs before parsing.
  for (let i = 0; i < 5; i++) {
    const r = await request.post('/api/public/signup/org', { data: {}, headers: ip });
    expect(r.status()).toBe(400);
  }
  const sixth = await request.post('/api/public/signup/org', { data: {}, headers: ip });
  expect(sixth.status()).toBe(429);
});
