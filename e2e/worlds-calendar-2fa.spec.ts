import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { E2E_GOOGLE_MOCK_PORT } from '../playwright.config';

// Worlds (docs/worlds.md): whatever an action produces stays in the world it was
// started from. Two surfaces that used to name the internship product for a
// SaleVali account: the authenticator entry 2FA enrolment creates, and the
// Google Calendar round-trip (its redirect_uri, where the callback lands, and
// the "source" of every mirrored event). "Arriving on the marketing site" is the
// forged proxy header the server reads first, as in worlds.spec.ts.
const MOCK = `http://127.0.0.1:${E2E_GOOGLE_MOCK_PORT}`;
const PW = 'WorldsCal123!';
const H = asHost(MARKETING_HOST);

const emails: string[] = [];
const orgIds: string[] = [];

async function seedMarketingOrg() {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: { name: `Worlds cal ${stamp}`, slug: `worlds-cal-${stamp}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
  return org;
}

function email(label: string) {
  const e = uniqueEmail(label);
  emails.push(e);
  return e;
}

test.afterEach(async () => {
  for (const e of emails.splice(0)) await cleanupByEmail(e);
  for (const id of orgIds.splice(0)) await prisma.organization.delete({ where: { id } }).catch(() => {});
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('2FA enrolment files the authenticator entry under the account\'s own product', async ({ playwright, baseURL }) => {
  const org = await seedMarketingOrg();
  const mkt = email('worlds-2fa-mkt');
  const int = email('worlds-2fa-int');
  await seedUser(mkt, PW, 'MENTOR', 'Worlds 2FA Rep', org.id);
  await seedUser(int, PW, 'MENTOR', 'Worlds 2FA Mentor');

  const marketingJar = await playwright.request.newContext({ baseURL });
  const internshipJar = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(marketingJar, mkt, PW, { host: MARKETING_HOST, headers: freshIp('worlds-2fa-m') })).error).toBeNull();
    const m = await (await marketingJar.post('/api/account/2fa', { headers: H, data: { action: 'setup' } })).json();
    // A SaleVali-only account — no twin in the other world — is still SaleVali.
    expect(m.otpauth.startsWith(`otpauth://totp/${encodeURIComponent(`SaleVali:${mkt}`)}?`)).toBe(true);
    expect(new URL(m.otpauth).searchParams.get('issuer')).toBe('SaleVali');

    expect((await signInViaApi(internshipJar, int, PW, { headers: freshIp('worlds-2fa-i') })).error).toBeNull();
    const i = await (await internshipJar.post('/api/account/2fa', { data: { action: 'setup' } })).json();
    expect(new URL(i.otpauth).searchParams.get('issuer')).toBe('Internship CRM');
  } finally {
    await marketingJar.dispose();
    await internshipJar.dispose();
  }
});

test('a SaleVali rep connects Google Calendar on the marketing host and the round-trip stays there', async ({ request }) => {
  const org = await seedMarketingOrg();
  const repEmail = email('worlds-gcal-rep');
  const leadEmail = email('worlds-gcal-lead');
  const rep = await seedUser(repEmail, PW, 'MENTOR', 'Worlds GCal Rep', org.id);
  const lead = await seedUser(leadEmail, 'x', 'MENTEE', 'Worlds GCal Lead', org.id);
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: rep.id, menteeId: lead.id, status: 'ACTIVE', orgId: org.id },
  });

  expect((await signInViaApi(request, repEmail, PW, { host: MARKETING_HOST, headers: freshIp('worlds-gcal') })).error).toBeNull();

  // Google only ever calls the redirect_uri registered with it (the configured
  // host). The marketing origin rides in the signed state, and the callback
  // there hands the browser straight back to the marketing host, where the
  // session lives (#2494) — the round-trip never finishes in the other product.
  const consent = await request.get('/api/integrations/google/connect', { headers: H, maxRedirects: 0 });
  expect(consent.status()).toBe(307);
  const consentUrl = new URL(consent.headers()['location']);
  const redirectUri = new URL(consentUrl.searchParams.get('redirect_uri')!);
  expect(redirectUri.pathname).toBe('/api/integrations/google/callback');
  const state = consentUrl.searchParams.get('state')!;

  const viaRegistered = await request.get(`/api/integrations/google/callback?code=ok&state=${encodeURIComponent(state)}`, {
    maxRedirects: 0,
  });
  const hop = new URL(viaRegistered.headers()['location']);
  expect(hop.hostname).toBe(MARKETING_HOST);
  expect(hop.pathname).toBe('/api/integrations/google/callback');

  const back = await request.get(`/api/integrations/google/callback?code=ok&state=${encodeURIComponent(state)}`, {
    headers: H,
    maxRedirects: 0,
  });
  const landing = new URL(back.headers()['location']);
  expect(landing.hostname).toBe(MARKETING_HOST);
  expect(landing.searchParams.get('google')).toBe('connected');

  // The mirrored event names the rep's product as its source.
  const title = `Worlds GCal demo ${crypto.randomBytes(3).toString('hex')}`;
  const created = await request.post('/api/meetings', {
    headers: H,
    data: { relationIds: [relation.id], title, scheduledAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString() },
  });
  expect(created.ok()).toBeTruthy();
  await expect
    .poll(
      async () => {
        const s = await (await request.get(`${MOCK}/__state`)).json();
        const ev = (s.events as { summary: string; source?: { title?: string } }[]).find((e) => e.summary === title);
        return ev?.source?.title ?? null;
      },
      { timeout: 15_000 },
    )
    .toBe('SaleVali');
});
