import { test, expect, type APIRequestContext } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

/**
 * The tenant welcome page (#1664): on a tenant's own VERIFIED host with a
 * welcome title, `/` greets in the tenant's words with Sign in / Apply; every
 * other case — our own host, an unverified domain, a tenant with no title —
 * is the landing page exactly as before, and a signed-in visitor is still sent
 * to their role home first. The tenant's text is plain text: markup in it is
 * shown, never run. Hosts are reserved example names reached with
 * X-Forwarded-Host, the way the reverse proxy sends them.
 */

const PASSWORD = 'Welcome123!';
const orgIds: string[] = [];
const emails: string[] = [];

test.afterAll(async () => {
  for (const e of emails) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

async function seedTenant(prefix: string, opts: { verified: boolean; title: string | null; body?: string | null }) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const host = `${prefix}-${stamp}.tenant.example.test`;
  const org = await prisma.organization.create({
    data: {
      name: `Welcome ${stamp}`,
      slug: `${prefix}-${stamp}`,
      brandName: `Acme ${stamp}`,
      plan: 'ENTERPRISE',
      publicHost: host,
      publicHostToken: 'tok',
      publicHostVerifiedAt: opts.verified ? new Date() : null,
      welcomeTitle: opts.title,
      welcomeBody: opts.body ?? null,
    },
  });
  orgIds.push(org.id);
  return { org, host };
}

/** The href of the <a> carrying this data-testid, whatever the attribute order. */
const hrefOf = (html: string, testId: string) => {
  const tag = new RegExp(`<a\\b[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? '';
  return /href="([^"]*)"/.exec(tag)?.[1] ?? null;
};

const root = async (request: APIRequestContext, host?: string) => {
  const res = await request.get('/', { headers: host ? { 'x-forwarded-host': host } : {}, maxRedirects: 0 });
  return { status: res.status(), location: res.headers()['location'] ?? null, html: res.status() === 200 ? await res.text() : '' };
};

test('a verified tenant host with a title shows the welcome page, as plain text, with both doors', async ({ request }) => {
  const body = 'Find your mentor here.\nIt takes five minutes.\n\n<script>window.__pwned=1</script>';
  const { host } = await seedTenant('welcome', { verified: true, title: 'Grow with Acme mentors', body });
  const r = await root(request, host);
  expect(r.status).toBe(200);
  expect(r.html).toContain('data-testid="tenant-welcome"');
  expect(r.html).toContain('Grow with Acme mentors');
  expect(r.html).toContain('Find your mentor here.</span><span><br/>It takes five minutes.');
  // The tenant's markup is text: escaped, never a live element.
  expect(r.html).toContain('&lt;script&gt;window.__pwned=1&lt;/script&gt;');
  expect(r.html).not.toContain('<script>window.__pwned=1</script>');
  expect(hrefOf(r.html, 'tenant-welcome-signin')).toBe('/auth/signin');
  expect(hrefOf(r.html, 'tenant-welcome-apply')).toBe('/apply');
  // None of our pitch on their door.
  expect(r.html).not.toContain('Everything you need');
});

test('every other host keeps the landing page', async ({ request }) => {
  const unverified = await seedTenant('welcome-unverified', { verified: false, title: 'Not proven yet' });
  const untitled = await seedTenant('welcome-untitled', { verified: true, title: null, body: 'Body without a headline' });
  for (const host of [undefined, unverified.host, untitled.host]) {
    const r = await root(request, host);
    expect(r.status, `host ${host ?? '(default)'}`).toBe(200);
    expect(r.html, `host ${host ?? '(default)'}`).not.toContain('data-testid="tenant-welcome"');
  }
});

test('a signed-in visitor on the tenant host still goes to their role home first', async ({ playwright, baseURL }) => {
  const { org, host } = await seedTenant('welcome-signed-in', { verified: true, title: 'Hello members' });
  const email = uniqueEmail('welcome-admin');
  emails.push(email);
  await seedUser(email, PASSWORD, 'ADMIN', 'Welcome Admin', org.id);
  const ctx = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(ctx, email, PASSWORD)).ok).toBe(true);
    const r = await root(ctx, host);
    expect(r.status).toBeGreaterThanOrEqual(300);
    expect(r.status).toBeLessThan(400);
    expect(r.location).toMatch(/\/admin/);
  } finally {
    await ctx.dispose();
  }
});

test('the admin editor writes the welcome within its limits, and an empty title turns it off', async ({ playwright, baseURL }) => {
  const { org, host } = await seedTenant('welcome-editor', { verified: true, title: null });
  const email = uniqueEmail('welcome-editor-admin');
  emails.push(email);
  await seedUser(email, PASSWORD, 'ADMIN', 'Welcome Editor', org.id);
  const ctx = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(ctx, email, PASSWORD)).ok).toBe(true);
    const tooLong = await ctx.patch('/api/admin/organizations', { data: { id: org.id, welcomeTitle: 'x'.repeat(121) } });
    expect(tooLong.status()).toBe(400);

    const ok = await ctx.patch('/api/admin/organizations', { data: { id: org.id, welcomeTitle: '  Welcome, Acme  ', welcomeBody: 'Line one\n\nLine two' } });
    expect(ok.status()).toBe(200);
    const row = await prisma.organization.findUnique({ where: { id: org.id }, select: { welcomeTitle: true, welcomeBody: true } });
    expect(row).toEqual({ welcomeTitle: 'Welcome, Acme', welcomeBody: 'Line one\n\nLine two' });
    // Read signed out: a signed-in request would be sent to its role home.
    const anon = await playwright.request.newContext({ baseURL });
    try {
      expect((await root(anon, host)).html).toContain('Welcome, Acme');
      const off = await ctx.patch('/api/admin/organizations', { data: { id: org.id, welcomeTitle: '' } });
      expect(off.status()).toBe(200);
      expect((await root(anon, host)).html).not.toContain('data-testid="tenant-welcome"');
    } finally {
      await anon.dispose();
    }
  } finally {
    await ctx.dispose();
  }
});
