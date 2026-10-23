import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { E2E_KLAVIYO_MOCK_PORT } from '../playwright.config';

// The Klaviyo pull connector (docs/integrations/klaviyo.md), against the local
// stand-in e2e/support/klaviyo-mock.mjs — never the real provider.
//
// Pins, end to end:
//   • the admin routes: ADMIN of a MARKETING org only, the org always the
//     session's — a second tenant neither sees nor feeds the first one's
//     connection or leads (@smoke: a security boundary);
//   • the key goes in and never comes out (no response carries it; the row
//     holds it sealed);
//   • the first import: paged through the provider's cursor, silent (no bell,
//     one aggregated activity line), every profile one account + lead at the
//     first stage, owned by the connecting admin;
//   • re-syncs: incremental by `updated`, update — never duplicate — and never
//     overwrite what a person typed; a new profile later rings the owner's bell;
//   • a 429 with a long Retry-After backs the connection off; a short one is
//     waited out inside the run;
//   • the preview is a dry run: nothing written;
//   • beyond profiles: lists, segments + members, metrics, allow-listed events,
//     campaigns + statistics and flows — idempotent, pruned by a full pass, a
//     forbidden resource failing alone, an erased person's events and
//     memberships removed and never written back (@smoke: a privacy boundary).

const MOCK = `http://127.0.0.1:${E2E_KLAVIYO_MOCK_PORT}`;
const PW = 'KlaviyoConn123';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function mock(path: string, body: unknown) {
  const res = await fetch(`${MOCK}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.ok).toBeTruthy();
}

async function mockRequests(key: string): Promise<{ method: string; path: string; revision: string | null }[]> {
  return (await (await fetch(`${MOCK}/__requests?key=${encodeURIComponent(key)}`)).json()).requests;
}

function iso(at: Date) {
  return at.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function profile(id: string, attributes: Record<string, unknown>) {
  return { type: 'profile', id, attributes: { updated: iso(new Date(Date.now() - 24 * 3600 * 1000)), ...attributes } };
}

async function marketingOrg(stamp: string) {
  const org = await prisma.organization.create({
    data: { name: `Klaviyo MKT ${stamp}`, slug: `klaviyo-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  const stages = templateStagePayload(preset, 'en').stages;
  await prisma.pipelineStage.createMany({
    data: stages.map((st) => ({
      orgId: org.id,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  const first = [...stages].filter((s) => !s.isOffPath).sort((a, b) => a.order - b.order)[0];
  return { org, firstStage: first.key };
}

async function cleanupOrg(orgId: string, emails: string[]) {
  const companies = await prisma.company.findMany({ where: { orgId }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, role: 'MENTEE' } }).catch(() => {});
  for (const email of emails) await cleanupByEmail(email);
  await prisma.externalProfileLink.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.externalConnection.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.contactPermission.deleteMany({ where: { companyId: { in: companyIds } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.source.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}

async function apiAs(
  playwright: { request: { newContext: (o?: object) => Promise<APIRequestContext> } },
  email: string,
  host?: string,
): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext(host ? { extraHTTPHeaders: asHost(host) } : {});
  expect((await signInViaApi(ctx, email, PW, host ? { host } : {})).ok).toBeTruthy();
  return ctx;
}

test(
  'the connector is an ADMIN-of-a-MARKETING-org door, the key never comes back out, and two tenants never meet',
  { tag: '@smoke' },
  async ({ playwright }) => {
    test.setTimeout(120_000);
    const stamp = `${Date.now()}-${Math.round(performance.now())}`;
    const { org: orgA } = await marketingOrg(`a-${stamp}`);
    const { org: orgB } = await marketingOrg(`b-${stamp}`);
    const internship = await prisma.organization.create({
      data: { name: `Klaviyo INT ${stamp}`, slug: `klaviyo-int-${stamp}`, vertical: 'INTERNSHIP' },
    });
    const adminA = uniqueEmail('kl-admin-a');
    const adminB = uniqueEmail('kl-admin-b');
    const repA = uniqueEmail('kl-rep-a');
    const intAdmin = uniqueEmail('kl-int-admin');
    await seedUser(adminA, PW, 'ADMIN', 'Klaviyo Admin A', orgA.id);
    await seedUser(adminB, PW, 'ADMIN', 'Klaviyo Admin B', orgB.id);
    await seedUser(repA, PW, 'MENTOR', 'Klaviyo Rep A', orgA.id);
    await seedUser(intAdmin, PW, 'ADMIN', 'Klaviyo Internship Admin', internship.id);
    const keyA = `pk_e2eA${stamp.replace(/\D/g, '')}`;
    const keyB = `pk_e2eB${stamp.replace(/\D/g, '')}`;
    await mock('/__account', { key: keyA, profiles: [profile(`A-${stamp}`, { email: `only-a-${stamp}@acme-sales.example.test`, organization: `Acme Sales A ${stamp}` })] });
    await mock('/__account', { key: keyB, profiles: [profile(`B-${stamp}`, { email: `only-b-${stamp}@acme-sales.example.test`, organization: `Acme Sales B ${stamp}` })] });

    const anon = await playwright.request.newContext({ extraHTTPHeaders: asHost(MARKETING_HOST) });
    const routes: [string, string][] = [
      ['GET', '/api/admin/integrations/klaviyo'],
      ['PUT', '/api/admin/integrations/klaviyo'],
      ['PATCH', '/api/admin/integrations/klaviyo'],
      ['DELETE', '/api/admin/integrations/klaviyo'],
      ['POST', '/api/admin/integrations/klaviyo/test'],
      ['POST', '/api/admin/integrations/klaviyo/sync'],
      ['POST', '/api/admin/integrations/klaviyo/preview'],
    ];
    const call = (ctx: APIRequestContext, method: string, path: string, data: unknown = {}) =>
      ctx.fetch(path, { method, data });
    try {
      for (const [method, path] of routes) expect((await call(anon, method, path, { key: keyA })).status(), `${method} ${path} anon`).toBe(401);

      const rep = await apiAs(playwright, repA, MARKETING_HOST);
      for (const [method, path] of routes) expect((await call(rep, method, path, { key: keyA })).status(), `${method} ${path} rep`).toBe(403);

      const intern = await apiAs(playwright, intAdmin);
      for (const [method, path] of routes) {
        const res = await call(intern, method, path, { key: keyA });
        expect(res.status(), `${method} ${path} internship admin`).toBe(403);
        expect((await res.json()).code).toBe('vertical_unavailable');
      }

      // A connects. No response — PUT, GET, sync — ever carries the key.
      const a = await apiAs(playwright, adminA, MARKETING_HOST);
      const badKey = await a.put('/api/admin/integrations/klaviyo', { data: { key: 'AbC123' } });
      expect(badKey.status()).toBe(400);
      expect((await badKey.json()).code).toBe('public_key');
      const unknownKey = await a.put('/api/admin/integrations/klaviyo', { data: { key: 'pk_e2e_unknown_account_key' } });
      expect(unknownKey.status()).toBe(400);
      expect((await unknownKey.json()).code).toBe('unauthorized');
      const put = await a.put('/api/admin/integrations/klaviyo', { data: { key: keyA } });
      expect(put.status()).toBe(200);
      const texts = [await put.text()];
      const view = await a.get('/api/admin/integrations/klaviyo');
      texts.push(await view.text());
      const viewBody = JSON.parse(texts[1]);
      expect(viewBody.connected).toBe(true);
      expect(viewBody.connection.keyLast4).toBe(keyA.slice(-4));
      const synced = await a.post('/api/admin/integrations/klaviyo/sync');
      expect(synced.status()).toBe(200);
      texts.push(await synced.text());
      texts.push(await (await a.post('/api/admin/integrations/klaviyo/test')).text());
      for (const text of texts) expect(text).not.toContain(keyA);
      const row = await prisma.externalConnection.findFirstOrThrow({ where: { orgId: orgA.id } });
      expect(row.sealedKey).not.toContain(keyA);
      expect(row.sealedKey.startsWith('v1.')).toBe(true);

      // B sees nothing of A, cannot sync A's connection, and its own sync
      // writes only into B.
      const b = await apiAs(playwright, adminB, MARKETING_HOST);
      expect((await (await b.get('/api/admin/integrations/klaviyo')).json()).connected).toBe(false);
      expect((await b.post('/api/admin/integrations/klaviyo/sync')).status()).toBe(404);
      expect((await b.put('/api/admin/integrations/klaviyo', { data: { key: keyB } })).status()).toBe(200);
      expect((await b.post('/api/admin/integrations/klaviyo/sync')).status()).toBe(200);

      const namesA = (await prisma.company.findMany({ where: { orgId: orgA.id }, select: { name: true } })).map((c) => c.name);
      const namesB = (await prisma.company.findMany({ where: { orgId: orgB.id }, select: { name: true } })).map((c) => c.name);
      expect(namesA).toEqual([`Acme Sales A ${stamp}`]);
      expect(namesB).toEqual([`Acme Sales B ${stamp}`]);
      const listB = await (await b.get('/api/companies?source=klaviyo')).json();
      expect(listB.companies.map((c: { name: string }) => c.name)).toEqual([`Acme Sales B ${stamp}`]);

      // B disconnecting touches nothing of A.
      expect((await b.delete('/api/admin/integrations/klaviyo')).status()).toBe(200);
      expect(await prisma.externalConnection.count({ where: { orgId: orgA.id } })).toBe(1);
      expect(await prisma.externalProfileLink.count({ where: { orgId: orgA.id } })).toBe(1);

      // The connector only ever READ from the provider.
      for (const r of [...(await mockRequests(keyA)), ...(await mockRequests(keyB))]) {
        expect(r.method).toBe('GET');
        expect(r.revision).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    } finally {
      await anon.dispose();
      await cleanupOrg(orgA.id, [adminA, repA]);
      await cleanupOrg(orgB.id, [adminB]);
      await cleanupByEmail(intAdmin);
      await prisma.organization.delete({ where: { id: internship.id } }).catch(() => {});
    }
  },
);

test('first import is paged and silent; re-syncs update without duplicating or overwriting; a new lead rings the owner; 429 backs off; the preview writes nothing', async ({ playwright }) => {
  test.setTimeout(240_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const { org, firstStage } = await marketingOrg(stamp);
  const adminEmail = uniqueEmail('kl-owner');
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Klaviyo Owner', org.id);
  const key = `pk_e2eM${stamp.replace(/\D/g, '')}`;
  const domain = `acme-sales-${stamp.replace(/\D/g, '')}.example.test`;

  const acmeId = `ACME-${stamp}`;
  const janeId = `JANE-${stamp}`;
  const profiles = [
    profile(acmeId, {
      email: `buyer@${domain}`,
      first_name: 'Bea',
      last_name: 'Buyer',
      organization: `Acme Sales ${stamp}`,
      phone_number: '+4930111111',
      title: 'Head of Ops',
      location: { city: 'Berlin', country: 'DE', ip: '203.0.113.7' },
      properties: { plan_interest: 'Pro' },
      subscriptions: { email: { marketing: { consent: 'SUBSCRIBED', method: 'LIST', method_detail: 'LISTNEWS' } } },
    }),
    profile(janeId, { email: `jane@${domain}`, first_name: 'Jane', last_name: 'Doe', properties: { utm_source: 'Partner', utm_medium: 'referral' } }),
  ];
  // Enough to need a second page (the provider pages at 100).
  for (let i = 0; i < 101; i++) {
    profiles.push(profile(`BULK-${i}-${stamp}`, { email: `bulk${i}@${domain}`, organization: `Bulk Co ${i} ${stamp}` }));
  }
  await mock('/__account', { key, profiles, lists: [{ id: 'LISTNEWS', name: 'Newsletter DE' }] });

  const api = await apiAs(playwright, adminEmail, MARKETING_HOST);
  const sync = async () => {
    const res = await api.post('/api/admin/integrations/klaviyo/sync', { timeout: 150_000 });
    expect(res.status()).toBe(200);
    return res.json();
  };
  try {
    expect((await api.put('/api/admin/integrations/klaviyo', { data: { key } })).status()).toBe(200);

    // The preview is a dry run of the same engine: rows planned, nothing written.
    const preview = await (await api.post('/api/admin/integrations/klaviyo/preview')).json();
    expect(preview.ok).toBe(true);
    expect(preview.rows.length).toBe(25);
    expect(preview.rows.every((r: { status: string }) => r.status === 'CREATE')).toBe(true);
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(0);
    expect(await prisma.externalProfileLink.count({ where: { orgId: org.id } })).toBe(0);

    // ── The first import: two pages, all of it, silently.
    const first = await sync();
    expect(first.outcome).toBe('ok');
    expect(first.pages).toBe(2);
    expect(first.counts.CREATE).toBe(103);
    expect(first.connection.initialSyncDoneAt).not.toBeNull();
    const firstRequests = (await mockRequests(key)).filter((r) => r.path.startsWith('/api/profiles'));
    expect(firstRequests.some((r) => r.path.includes('page%5Bcursor%5D='))).toBe(true);
    expect(firstRequests.some((r) => r.path.includes('filter='))).toBe(false);

    expect(await prisma.company.count({ where: { orgId: org.id, createdBySource: 'klaviyo' } })).toBe(103);
    expect(await prisma.externalProfileLink.count({ where: { orgId: org.id } })).toBe(103);
    const acmeLink = await prisma.externalProfileLink.findFirstOrThrow({ where: { orgId: org.id, externalId: acmeId } });
    const acme = await prisma.company.findUniqueOrThrow({ where: { id: acmeLink.companyId as string } });
    expect(acme.name).toBe(`Acme Sales ${stamp}`);
    expect(acme.contactEmail).toBe(`buyer@${domain}`);
    expect(acme.contactPhone).toBe('+4930111111');
    expect(acme.country).toBe('DE');
    expect(acmeLink.sourceName).toBe('klaviyo:list/Newsletter DE');
    expect(acmeLink.attributes).not.toContain('203.0.113.7');
    expect(JSON.parse(acmeLink.consent as string).email.consent).toBe('SUBSCRIBED');
    // Unassigned: the account and its lead person, but nobody's funnel record.
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id } })).toBe(0);
    const acmeLead = await prisma.user.findFirstOrThrow({
      where: { orgId: org.id, companyId: acme.id, role: 'MENTEE' },
      select: { id: true, email: true, source: { select: { name: true } } },
    });
    expect(acmeLead.email).not.toBe(`buyer@${domain}`); // a stand-in, never the mailbox
    expect(acmeLead.source?.name).toBe('klaviyo:list/Newsletter DE');
    // The pool lists it; taking it puts it on the taker's book at the first stage, once.
    const pool = await (await api.get('/api/sales/pool')).json();
    expect(pool.total).toBe(103);
    expect(pool.leads.length).toBe(50); // one page, the newest first
    expect(pool.leads.every((l: { company: { contactEmail: string | null } | null }) => Boolean(l.company?.contactEmail))).toBe(true);
    const claim = await api.post(`/api/sales/pool/${acmeLead.id}/claim`);
    expect(claim.status()).toBe(201);
    const relation = await prisma.mentorshipRelation.findFirstOrThrow({ where: { id: (await claim.json()).relationId } });
    expect(relation.pipelineStatus).toBe(firstStage);
    expect(relation.mentorId).toBe(admin.id);
    expect(relation.companyId).toBe(acme.id);
    expect((await api.post(`/api/sales/pool/${acmeLead.id}/claim`)).status()).toBe(409);
    expect((await (await api.get('/api/sales/pool')).json()).total).toBe(102);
    const janeLink = await prisma.externalProfileLink.findFirstOrThrow({ where: { orgId: org.id, externalId: janeId } });
    expect(janeLink.sourceName).toBe('utm:partner/referral/-');
    // No contact permission beyond the machine's NONE.
    expect(await prisma.contactPermission.count({ where: { companyId: acme.id, basis: { not: 'NONE' } } })).toBe(0);
    // Silent: no bell; exactly one aggregated activity line.
    expect(await prisma.notification.count({ where: { userId: admin.id, type: 'integration.newLeads' } })).toBe(0);
    expect(await prisma.activityLog.count({ where: { orgId: org.id, action: 'integration.klaviyo.initial_import' } })).toBe(1);
    expect(await prisma.activityLog.count({ where: { orgId: org.id, action: 'marketing.account.created' } })).toBe(0);

    // ── A re-sync reads only what changed since, and changes nothing.
    const again = await sync();
    expect(again.counts.CREATE).toBe(0);
    const againRequests = (await mockRequests(key)).filter((r) => r.path.startsWith('/api/profiles')).slice(firstRequests.length);
    expect(againRequests.length).toBeGreaterThan(0);
    expect(againRequests.every((r) => decodeURIComponent(r.path).includes('filter=greater-than(updated,'))).toBe(true);
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(103);

    // ── A person edits the phone; the provider changes phone AND city later.
    await prisma.company.update({ where: { id: acme.id }, data: { contactPhone: '+49 30 999 999' } });
    const lead = relation.menteeId;
    await prisma.user.update({ where: { id: lead }, data: { city: null } });
    await mock('/__profile', {
      key,
      profile: profile(acmeId, {
        ...profiles[0].attributes,
        phone_number: '+4930222222',
        location: { city: 'Hamburg', country: 'DE' },
        updated: iso(new Date(Date.now() + 60_000)),
      }),
    });
    const edited = await sync();
    expect(edited.counts.UPDATE).toBeGreaterThanOrEqual(1);
    expect(edited.counts.CREATE).toBe(0);
    const acmeAfter = await prisma.company.findUniqueOrThrow({ where: { id: acme.id } });
    expect(acmeAfter.contactPhone).toBe('+49 30 999 999'); // what the person typed stays
    expect((await prisma.user.findUniqueOrThrow({ where: { id: lead } })).city).toBe('Hamburg'); // a gap is filled
    expect((await prisma.externalProfileLink.findFirstOrThrow({ where: { id: acmeLink.id } })).attributes).toContain('Hamburg');
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(103);

    // ── The same address under a new profile id is the same lead, not a twin.
    await mock('/__profile', { key, profile: profile(`JANE2-${stamp}`, { email: `jane@${domain}`, first_name: 'Jane', last_name: 'Doe', updated: iso(new Date(Date.now() + 61_000)) }) });
    // ── And a genuinely new profile, after the first import, rings the owner once.
    await mock('/__profile', { key, profile: profile(`NEW-${stamp}`, { email: `new@${domain}`, organization: `Fresh Lead ${stamp}`, updated: iso(new Date(Date.now() + 62_000)) }) });
    const later = await sync();
    expect(later.counts.CREATE).toBe(1);
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(104);
    const jane2 = await prisma.externalProfileLink.findFirstOrThrow({ where: { orgId: org.id, externalId: `JANE2-${stamp}` } });
    expect(jane2.companyId).toBe(janeLink.companyId);
    const bells = await prisma.notification.findMany({ where: { userId: admin.id, type: 'integration.newLeads' } });
    expect(bells.length).toBe(1);
    expect((bells[0].params as { count: number }).count).toBe(1);

    // ── 429 with a long Retry-After: the run stops and the connection backs off.
    await mock('/__ratelimit', { key, count: 2, retryAfter: 120 });
    const limited = await sync();
    expect(limited.outcome).toBe('error');
    expect(limited.code).toBe('rate_limited');
    const backedOff = await prisma.externalConnection.findFirstOrThrow({ where: { orgId: org.id } });
    expect(backedOff.failures).toBe(1);
    expect(backedOff.lastErrorCode).toBe('rate_limited');
    expect(backedOff.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 100_000);

    // ── A short one is waited out inside the run, and success clears the backoff.
    await mock('/__ratelimit', { key, count: 1, retryAfter: 1 });
    const recovered = await sync();
    expect(recovered.outcome).toBe('ok');
    const cleared = await prisma.externalConnection.findFirstOrThrow({ where: { orgId: org.id } });
    expect(cleared.failures).toBe(0);
    expect(cleared.nextAttemptAt).toBeNull();

    // ── Paused: "Sync now" is refused until resumed.
    expect((await api.patch('/api/admin/integrations/klaviyo', { data: { enabled: false } })).status()).toBe(200);
    expect((await api.post('/api/admin/integrations/klaviyo/sync')).status()).toBe(409);

    // Read-only, throughout.
    expect((await mockRequests(key)).every((r) => r.method === 'GET')).toBe(true);
  } finally {
    await api.dispose();
    await cleanupOrg(org.id, [adminEmail]);
  }
});

test('the admin card connects, syncs and shows the profile on the account; the companies list filters by Klaviyo', async ({ page }) => {
  test.setTimeout(150_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const { org } = await marketingOrg(`ui-${stamp}`);
  const adminEmail = uniqueEmail('kl-ui-admin');
  await seedUser(adminEmail, PW, 'ADMIN', 'Klaviyo UI Admin', org.id);
  const key = `pk_e2eU${stamp.replace(/\D/g, '')}`;
  await mock('/__account', {
    key,
    profiles: [
      profile(`UI-${stamp}`, {
        email: `ui-${stamp}@acme-sales.example.test`,
        organization: `Acme Sales UI ${stamp}`,
        location: { city: 'Köln', country: 'DE' },
        properties: { favourite_channel: 'Marketplace' },
        subscriptions: { email: { marketing: { consent: 'SUBSCRIBED', method: 'KLAVIYO_FORM', method_detail: 'Footer' } } },
      }),
    ],
  });
  const manual = await prisma.company.create({ data: { orgId: org.id, name: `Typed In ${stamp}` } });
  try {
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, adminEmail, PW, '/admin');
    await gotoSettled(page, '/admin/integrations');
    const card = page.getByTestId('klaviyo-card');
    await expect(card).toBeVisible();
    // Filled until the card has hydrated: a value typed before React takes the
    // input over leaves its state empty and the button disabled.
    await expect(async () => {
      await card.getByTestId('klaviyo-key-input').fill(key);
      await expect(card.getByTestId('klaviyo-save')).toBeEnabled({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await card.getByTestId('klaviyo-save').click();
    // Saving tests the key against the provider first: allow a slow first request.
    await expect(card.getByTestId('klaviyo-key-last4')).toContainText(key.slice(-4), { timeout: 45_000 });
    await expect(card.getByTestId('klaviyo-key-input')).toHaveValue('');
    await card.getByTestId('klaviyo-sync-now').click();
    await expect(card.getByTestId('klaviyo-last-status')).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('klaviyo-linked')).toContainText('1');

    const link = await prisma.externalProfileLink.findFirstOrThrow({ where: { orgId: org.id } });
    await gotoSettled(page, `/admin/companies/${link.companyId}`);
    const info = page.getByTestId('company-klaviyo-card');
    await expect(info).toBeVisible();
    await expect(info.getByTestId('company-klaviyo-source')).toContainText('klaviyo:klaviyo_form/Footer');
    await expect(info.getByTestId('company-klaviyo-location')).toContainText('Köln');
    await expect(info.getByTestId('company-klaviyo-properties')).toContainText('Marketplace');

    await gotoSettled(page, '/admin/companies?source=klaviyo');
    await expect(page.getByTestId('companies-source-filter')).toHaveValue('klaviyo');
    await expect(page.getByTestId('companies-total')).toContainText('1');
    await expect(page.getByTestId('companies-list').getByText(`Acme Sales UI ${stamp}`, { exact: true })).toBeVisible();
    await expect(page.getByTestId('companies-list').getByText(manual.name, { exact: true })).toHaveCount(0);
  } finally {
    await cleanupOrg(org.id, [adminEmail]);
  }
});

test('a second person of the same company — same page or a later sync — is linked, never written onto the first person; a new key starts the query over', async ({ playwright }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const { org } = await marketingOrg(`pair-${stamp}`);
  const adminEmail = uniqueEmail('kl-pair-admin');
  await seedUser(adminEmail, PW, 'ADMIN', 'Klaviyo Pair Admin', org.id);
  const key = `pk_e2eP${stamp.replace(/\D/g, '')}`;
  const domain = `pair-${stamp.replace(/\D/g, '')}.example.test`;
  const sameCo = `Acme Sales Same ${stamp}`;
  const pairCo = `Acme Sales Pair ${stamp}`;
  // P1 has no phone and no city, so both are gaps a careless sync would fill.
  await mock('/__account', {
    key,
    profiles: [
      profile(`P1-${stamp}`, { email: `ann@${domain}`, first_name: 'Ann', last_name: 'First', organization: sameCo }),
      // Two people of one company in the SAME page.
      profile(`P3-${stamp}`, { email: `cat@${domain}`, first_name: 'Cat', last_name: 'Third', organization: pairCo }),
      profile(`P4-${stamp}`, { email: `dan@${domain}`, first_name: 'Dan', last_name: 'Fourth', organization: pairCo, phone_number: '+4922844' }),
    ],
  });
  const api = await apiAs(playwright, adminEmail, MARKETING_HOST);
  const sync = async () => {
    const res = await api.post('/api/admin/integrations/klaviyo/sync', { timeout: 120_000 });
    expect(res.status()).toBe(200);
    return res.json();
  };
  const link = (id: string) => prisma.externalProfileLink.findFirstOrThrow({ where: { orgId: org.id, externalId: id } });
  try {
    expect((await api.put('/api/admin/integrations/klaviyo', { data: { key } })).status()).toBe(200);
    const first = await sync();
    expect(first.counts.SKIP).toBe(0);
    expect(first.counts.ERROR).toBe(0);
    // One account per company; the same-page colleague is linked to it, not dropped.
    const names = (await prisma.company.findMany({ where: { orgId: org.id }, select: { name: true } })).map((c) => c.name);
    expect(names.sort()).toEqual([pairCo, sameCo].sort());
    const p3 = await link(`P3-${stamp}`);
    const p4 = await link(`P4-${stamp}`);
    expect(p4.companyId).toBe(p3.companyId);
    expect(p4.leadUserId).toBeNull();
    const pair = await prisma.company.findUniqueOrThrow({ where: { id: p3.companyId as string } });
    expect(pair.contactEmail).toBe(`cat@${domain}`);
    expect(pair.contactPhone).toBeNull(); // Dan's line never lands on Cat's account

    const p1 = await link(`P1-${stamp}`);
    const p1Lead = p1.leadUserId as string;
    expect(p1Lead).toBeTruthy();

    // A colleague signs up later, then edits their profile.
    const p2Attrs = {
      email: `bea@${domain}`,
      first_name: 'Bea',
      last_name: 'Second',
      organization: sameCo,
      phone_number: '+4922899',
      location: { city: 'Bonn', country: 'DE' },
    };
    await mock('/__profile', { key, profile: profile(`P2-${stamp}`, { ...p2Attrs, updated: iso(new Date(Date.now() + 60_000)) }) });
    await sync();
    const p2 = await link(`P2-${stamp}`);
    expect(p2.companyId).toBe(p1.companyId);
    expect(p2.leadUserId).toBeNull();
    // Both colleagues change their profiles — still nobody else's data moves.
    await mock('/__profile', { key, profile: profile(`P2-${stamp}`, { ...p2Attrs, title: 'Buyer', updated: iso(new Date(Date.now() + 120_000)) }) });
    await mock('/__profile', {
      key,
      profile: profile(`P4-${stamp}`, {
        email: `dan@${domain}`,
        first_name: 'Dan',
        last_name: 'Fourth',
        organization: pairCo,
        phone_number: '+4922844',
        location: { city: 'Essen', country: 'DE' },
        updated: iso(new Date(Date.now() + 121_000)),
      }),
    });
    const later = await sync();
    expect(later.counts.ERROR).toBe(0);

    const ann = await prisma.user.findUniqueOrThrow({ where: { id: p1Lead }, select: { phone: true, city: true, country: true } });
    expect(ann).toEqual({ phone: null, city: null, country: null });
    const same = await prisma.company.findUniqueOrThrow({ where: { id: p1.companyId as string } });
    expect(same.contactEmail).toBe(`ann@${domain}`);
    expect(same.contactName).toBe('Ann First');
    expect(same.contactPhone).toBeNull();
    expect(same.country).toBeNull();
    const catLead = await prisma.user.findUniqueOrThrow({ where: { id: p3.leadUserId as string }, select: { phone: true, city: true } });
    expect(catLead).toEqual({ phone: null, city: null });
    expect((await link(`P2-${stamp}`)).attributes).toContain('Buyer'); // the colleague's own data stays on their link
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(2);

    // A DIFFERENT key: the query starts over (quiet), so an old profile of that
    // account is imported rather than hidden behind the previous cursor.
    const key2 = `pk_e2eQ${stamp.replace(/\D/g, '')}`;
    await mock('/__account', {
      key: key2,
      profiles: [
        profile(`OLD-${stamp}`, {
          email: `old@${domain}`,
          organization: `Acme Sales Old ${stamp}`,
          updated: iso(new Date(Date.now() - 30 * 24 * 3600 * 1000)),
        }),
      ],
    });
    expect((await api.put('/api/admin/integrations/klaviyo', { data: { key: key2 } })).status()).toBe(200);
    const reset = await prisma.externalConnection.findFirstOrThrow({ where: { orgId: org.id } });
    expect(reset.profilesSince).toBeNull();
    expect(reset.initialSyncDoneAt).toBeNull();
    const switched = await sync();
    expect(switched.counts.CREATE).toBe(1);
    // Re-saving the same key keeps the cursor.
    const before = await prisma.externalConnection.findFirstOrThrow({ where: { orgId: org.id } });
    expect(before.initialSyncDoneAt).not.toBeNull();
    expect((await api.put('/api/admin/integrations/klaviyo', { data: { key: key2 } })).status()).toBe(200);
    const after = await prisma.externalConnection.findFirstOrThrow({ where: { orgId: org.id } });
    expect(after.profilesSince?.getTime()).toBe(before.profilesSince?.getTime());
    expect(after.initialSyncDoneAt).not.toBeNull();
  } finally {
    await api.dispose();
    await cleanupOrg(org.id, [adminEmail]);
  }
});

test('an erased person is never written back by the next sync — neither onto the account nor as a new one, nor after a reconnect', { tag: '@smoke' }, async ({ playwright }) => {
  test.setTimeout(150_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const { org } = await marketingOrg(`erase-${stamp}`);
  const adminEmail = uniqueEmail('kl-erase-admin');
  await seedUser(adminEmail, PW, 'ADMIN', 'Klaviyo Erase Admin', org.id);
  const key = `pk_e2eE${stamp.replace(/\D/g, '')}`;
  const domain = `erase-${stamp.replace(/\D/g, '')}.example.test`;
  const contactAttrs = {
    email: `eve@${domain}`,
    first_name: 'Eve',
    last_name: 'Contact',
    organization: `Acme Sales Erase ${stamp}`,
    phone_number: '+4911111',
  };
  const leadAttrs = {
    email: `fay@${domain}`,
    first_name: 'Fay',
    last_name: 'Lead',
    organization: `Acme Sales Anon ${stamp}`,
    phone_number: '+4922222',
    location: { city: 'Köln', country: 'DE' },
  };
  await mock('/__account', { key, profiles: [profile(`E1-${stamp}`, contactAttrs), profile(`E2-${stamp}`, leadAttrs)] });
  const api = await apiAs(playwright, adminEmail, MARKETING_HOST);
  const sync = async () => {
    const res = await api.post('/api/admin/integrations/klaviyo/sync', { timeout: 120_000 });
    expect(res.status()).toBe(200);
    return res.json();
  };
  try {
    expect((await api.put('/api/admin/integrations/klaviyo', { data: { key } })).status()).toBe(200);
    await sync();
    const e1 = await prisma.externalProfileLink.findFirstOrThrow({ where: { orgId: org.id, externalId: `E1-${stamp}` } });
    const e2 = await prisma.externalProfileLink.findFirstOrThrow({ where: { orgId: org.id, externalId: `E2-${stamp}` } });
    expect(e1.emailHash).toMatch(/^[0-9a-f]{64}$/);

    // E1: the account's contact is forgotten (an account-less contact).
    const forgot = await api.post('/api/admin/company-contacts/forget', {
      data: { email: `eve@${domain}`, confirmEmail: `eve@${domain}`, adminPassword: PW },
    });
    expect(forgot.status()).toBe(200);
    // E2: the lead is erased through its account.
    const lead = await prisma.user.findUniqueOrThrow({ where: { id: e2.leadUserId as string }, select: { id: true, fullName: true } });
    const erased = await api.post(`/api/admin/users/${lead.id}/erase`, {
      data: { mode: 'anonymize', confirmName: lead.fullName, adminPassword: PW },
    });
    expect(erased.status()).toBe(200);

    for (const id of [e1.id, e2.id]) {
      const t = await prisma.externalProfileLink.findUniqueOrThrow({ where: { id } });
      expect(t.erasedAt).not.toBeNull();
      expect({ companyId: t.companyId, leadUserId: t.leadUserId, emailHash: t.emailHash, attributes: t.attributes, consent: t.consent }).toEqual({
        companyId: null,
        leadUserId: null,
        emailHash: null,
        attributes: null,
        consent: null,
      });
    }

    // Both profiles change in the provider; the next sync skips them.
    await mock('/__profile', { key, profile: profile(`E1-${stamp}`, { ...contactAttrs, updated: iso(new Date(Date.now() + 60_000)) }) });
    await mock('/__profile', { key, profile: profile(`E2-${stamp}`, { ...leadAttrs, updated: iso(new Date(Date.now() + 61_000)) }) });
    const after = await sync();
    expect(after.counts.SKIP).toBe(2);
    expect(after.counts.CREATE).toBe(0);
    expect(after.counts.UPDATE).toBe(0);
    const account = await prisma.company.findUniqueOrThrow({ where: { id: e1.companyId as string } });
    expect({ contactEmail: account.contactEmail, contactName: account.contactName, contactPhone: account.contactPhone }).toEqual({
      contactEmail: null,
      contactName: null,
      contactPhone: null,
    });
    const anon = await prisma.user.findUniqueOrThrow({ where: { id: lead.id }, select: { phone: true, city: true } });
    expect(anon).toEqual({ phone: null, city: null });
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(2);
    expect(await prisma.company.count({ where: { orgId: org.id, contactEmail: `eve@${domain}` } })).toBe(0);

    // Disconnect and connect again: the tombstones outlive the connection, so
    // the fresh connection's quiet first import still skips both people.
    expect((await api.delete('/api/admin/integrations/klaviyo')).status()).toBe(200);
    expect(await prisma.externalProfileLink.count({ where: { orgId: org.id, erasedAt: { not: null } } })).toBe(2);
    expect(await prisma.externalProfileLink.count({ where: { orgId: org.id, erasedAt: null } })).toBe(0);
    expect((await api.put('/api/admin/integrations/klaviyo', { data: { key } })).status()).toBe(200);
    const again = await sync();
    expect(again.counts.SKIP).toBe(2);
    expect(again.counts.CREATE).toBe(0);
    expect(again.counts.UPDATE).toBe(0);
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(2);
  } finally {
    await api.dispose();
    await cleanupOrg(org.id, [adminEmail]);
  }
});

test('beyond profiles: lists, segments + members, metrics, allow-listed events, campaigns + statistics, flows — idempotent, pruned on a full pass, one forbidden resource fails alone, an erased person\'s events and memberships go', { tag: '@smoke' }, async ({ playwright }) => {
  test.setTimeout(240_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const n = stamp.replace(/\D/g, '');
  const { org } = await marketingOrg(`res-${stamp}`);
  const adminEmail = uniqueEmail('kl-res-admin');
  await seedUser(adminEmail, PW, 'ADMIN', 'Klaviyo Resource Admin', org.id);
  const key = `pk_e2eR${n}`;
  const domain = `res-${n}.example.test`;
  const P1 = `RP1${n}`;
  const P2 = `RP2${n}`;
  const days = (d: number) => iso(new Date(Date.now() - d * 24 * 3600 * 1000));
  await mock('/__account', {
    key,
    profiles: [profile(P1, { email: `pat@${domain}`, first_name: 'Pat', last_name: 'Lead', organization: `Acme Sales Res ${stamp}` })],
    lists: [{ id: `L1${n}`, name: 'Newsletter' }],
    segments: [{ id: `S1${n}`, name: 'Engaged' }],
    members: {
      [`L1${n}`]: [{ id: P1, joined_group_at: days(30) }, { id: P2, joined_group_at: days(20) }],
      [`S1${n}`]: [{ id: P1, joined_group_at: days(10) }, { id: P2, joined_group_at: days(9) }],
    },
    metrics: [
      { id: `M1${n}`, name: 'Opened Email' },
      { id: `M2${n}`, name: 'Received Email' },
      { id: `M3${n}`, name: 'Placed Order' },
    ],
    events: [
      { id: `E1${n}`, metric: `M1${n}`, profile: P1, datetime: days(5), properties: { Subject: 'Hello' } },
      { id: `E2${n}`, metric: `M2${n}`, profile: P1, datetime: days(5) }, // not allow-listed
      { id: `E3${n}`, metric: `M1${n}`, profile: P2, datetime: days(4) },
      { id: `E0${n}`, metric: `M1${n}`, profile: P2, datetime: days(800) }, // beyond the 13-month window
    ],
    campaigns: [{ id: `C1${n}`, name: 'Autumn', updated_at: days(3), messages: [{ id: `CM1${n}`, name: 'Email', status: 'sent' }] }],
    flows: [{ id: `F1${n}`, name: 'Welcome' }],
    report: [{ groupings: { campaign_id: `C1${n}`, campaign_message_id: `CM1${n}`, send_channel: 'email' }, statistics: { recipients: 100, open_rate: 0.5 } }],
  });
  const api = await apiAs(playwright, adminEmail, MARKETING_HOST);
  const syncAll = async () => {
    const res = await api.post('/api/admin/integrations/klaviyo/sync', { data: { scope: 'all' }, timeout: 180_000 });
    expect(res.status()).toBe(200);
    return res.json();
  };
  const counts = async () => ({
    audiences: await prisma.externalAudience.count({ where: { orgId: org.id } }),
    members: await prisma.externalAudienceMember.count({ where: { orgId: org.id } }),
    metrics: await prisma.externalMetric.count({ where: { orgId: org.id } }),
    events: await prisma.externalEvent.count({ where: { orgId: org.id } }),
    campaigns: await prisma.externalCampaign.count({ where: { orgId: org.id } }),
    messages: await prisma.externalCampaignMessage.count({ where: { orgId: org.id } }),
    stats: await prisma.externalCampaignStat.count({ where: { orgId: org.id } }),
    flows: await prisma.externalFlow.count({ where: { orgId: org.id } }),
  });
  try {
    expect((await api.put('/api/admin/integrations/klaviyo', { data: { key } })).status()).toBe(200);
    const first = await syncAll();
    expect(first.resourcesOutcome).toBe('ok');
    expect(await counts()).toEqual({ audiences: 2, members: 4, metrics: 3, events: 2, campaigns: 1, messages: 1, stats: 1, flows: 1 });
    const ev = await prisma.externalEvent.findFirstOrThrow({ where: { orgId: org.id, externalId: `E1${n}` } });
    expect(ev.profileExternalId).toBe(P1);
    expect(JSON.parse(ev.properties as string)).toEqual({ Subject: 'Hello' });
    const stat = await prisma.externalCampaignStat.findFirstOrThrow({ where: { orgId: org.id } });
    expect(stat.recipients).toBe(100);
    // 'Placed Order' exists, so the conversion figures would be kept; the report had none.
    expect(JSON.parse(stat.statistics)).toEqual({ recipients: 100, open_rate: 0.5 });
    // The card's status lines.
    const byName = Object.fromEntries((first.resources as { resource: string; rows: number; status: string }[]).map((r) => [r.resource, r]));
    expect(byName.events.rows).toBe(2);
    expect(byName.members.status).toBe('ok');

    // Read-only throughout: GETs, plus exactly one reporting query; the revision is pinned.
    const reqs = await mockRequests(key);
    expect(reqs.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/campaign-values-reports']);
    expect(new Set(reqs.map((r) => r.revision))).toEqual(new Set(['2026-10-15']));
    expect(reqs.some((r) => r.path.startsWith('/api/events') && decodeURIComponent(r.path).includes(`M2${n}`))).toBe(false);

    // A second run writes no duplicate, and the statistics are not queried again (daily, 225/day).
    await syncAll();
    expect(await counts()).toEqual({ audiences: 2, members: 4, metrics: 3, events: 2, campaigns: 1, messages: 1, stats: 1, flows: 1 });
    expect((await mockRequests(key)).filter((r) => r.method === 'POST').length).toBe(1);

    // Deleted on the provider's side: invisible to an incremental pass, removed by the next full one.
    await mock('/__account', {
      key,
      profiles: [profile(P1, { email: `pat@${domain}`, first_name: 'Pat', last_name: 'Lead', organization: `Acme Sales Res ${stamp}` })],
      lists: [],
      segments: [{ id: `S1${n}`, name: 'Engaged' }],
      members: { [`S1${n}`]: [{ id: P1, joined_group_at: days(10) }] },
      metrics: [{ id: `M1${n}`, name: 'Opened Email' }, { id: `M3${n}`, name: 'Placed Order' }],
      events: [{ id: `E4${n}`, metric: `M1${n}`, profile: P1, datetime: days(1) }],
      campaigns: [{ id: `C1${n}`, name: 'Autumn', updated_at: days(3), messages: [{ id: `CM1${n}`, name: 'Email', status: 'sent' }] }],
      flows: [{ id: `F1${n}`, name: 'Welcome' }],
      report: [],
    });
    await prisma.externalSyncState.updateMany({ where: { orgId: org.id }, data: { lastFullAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) } });
    // …and flows lose their scope: that resource alone fails.
    await mock('/__forbid', { key, paths: ['/api/flows'] });
    const pruned = await syncAll();
    expect(pruned.resourcesOutcome).toBe('partial');
    const after = await counts();
    expect(after.audiences).toBe(1); // the list is gone, and its members with it
    expect(after.members).toBe(1); // P2 left the segment
    expect(after.metrics).toBe(2);
    expect(after.events).toBe(3); // events are history: pruned only by retention or erasure
    expect(after.flows).toBe(1); // kept as it was: the failed pass removed nothing
    const flowState = await prisma.externalSyncState.findFirstOrThrow({ where: { orgId: org.id, resource: 'flows' } });
    expect(flowState.status).toBe('error');
    expect(flowState.errorCode).toBe('forbidden');
    expect(flowState.nextAttemptAt).not.toBeNull();
    const listMemberStates = await prisma.externalSyncState.count({ where: { orgId: org.id, resource: `members:L1${n}` } });
    expect(listMemberStates).toBe(0);
    const okStates = await prisma.externalSyncState.findMany({ where: { orgId: org.id, resource: { in: ['lists', 'segments', 'metrics', 'campaigns'] } } });
    expect(okStates.every((s) => s.status === 'ok')).toBe(true);

    // Erasing P1's lead removes their events and memberships; a later event of theirs is never written.
    const link = await prisma.externalProfileLink.findFirstOrThrow({ where: { orgId: org.id, externalId: P1 } });
    const lead = await prisma.user.findUniqueOrThrow({ where: { id: link.leadUserId as string }, select: { id: true, fullName: true } });
    const erased = await api.post(`/api/admin/users/${lead.id}/erase`, { data: { mode: 'anonymize', confirmName: lead.fullName, adminPassword: PW } });
    expect(erased.status()).toBe(200);
    expect(await prisma.externalEvent.count({ where: { orgId: org.id, profileExternalId: P1 } })).toBe(0);
    expect(await prisma.externalAudienceMember.count({ where: { orgId: org.id, profileExternalId: P1 } })).toBe(0);
    await mock('/__forbid', { key, paths: [] });
    // The provider still has P1 in the segment, and records a NEW event of theirs.
    await mock('/__account', {
      key,
      profiles: [profile(P1, { email: `pat@${domain}`, first_name: 'Pat', last_name: 'Lead', organization: `Acme Sales Res ${stamp}` })],
      segments: [{ id: `S1${n}`, name: 'Engaged' }],
      members: { [`S1${n}`]: [{ id: P1, joined_group_at: days(10) }, { id: P2, joined_group_at: days(9) }] },
      metrics: [{ id: `M1${n}`, name: 'Opened Email' }],
      events: [{ id: `E5${n}`, metric: `M1${n}`, profile: P1, datetime: iso(new Date(Date.now() + 60_000)) }],
    });
    await prisma.externalSyncState.updateMany({ where: { orgId: org.id }, data: { lastFullAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) } });
    await syncAll();
    expect(await prisma.externalEvent.count({ where: { orgId: org.id, profileExternalId: P1 } })).toBe(0);
    expect(await prisma.externalAudienceMember.count({ where: { orgId: org.id, profileExternalId: P1 } })).toBe(0);
    expect(await prisma.externalEvent.count({ where: { orgId: org.id, profileExternalId: P2 } })).toBe(1);
    expect(await prisma.externalAudienceMember.count({ where: { orgId: org.id, profileExternalId: P2 } })).toBe(1);

    // Disconnecting removes everything the connector kept beyond the leads.
    expect((await api.delete('/api/admin/integrations/klaviyo')).status()).toBe(200);
    expect(await counts()).toEqual({ audiences: 0, members: 0, metrics: 0, events: 0, campaigns: 0, messages: 0, stats: 0, flows: 0 });
    expect(await prisma.externalSyncState.count({ where: { orgId: org.id } })).toBe(0);
  } finally {
    await api.dispose();
    await cleanupOrg(org.id, [adminEmail]);
  }
});

test('unassigned leads: the real address shows, shared and ignored phones are dropped, a rep takes one, and the reset deletes only untouched accounts and re-imports them', async ({ playwright }) => {
  test.setTimeout(240_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const n = stamp.replace(/\D/g, '');
  const { org, firstStage } = await marketingOrg(`pool-${stamp}`);
  const adminEmail = uniqueEmail('kl-pool-admin');
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Klaviyo Pool Admin', org.id);
  const key = `pk_e2eP${n}`;
  const domain = `pool-${n}.example.test`;
  const shared = '+49176000' + n.slice(-5);
  const switchboard = '+49 30 9' + n.slice(-6);
  const personal = '+49171' + n.slice(-7);
  const people = [1, 2, 3, 4].map((i) =>
    profile(`S${i}-${n}`, { email: `shared${i}@${domain}`, first_name: `Shared${i}`, organization: `Acme Sales Shared ${i} ${stamp}`, phone_number: shared }),
  );
  await mock('/__account', {
    key,
    profiles: [
      ...people,
      profile(`B-${n}`, { email: `board@${domain}`, first_name: 'Board', organization: `Acme Sales Board ${stamp}`, phone_number: switchboard.replace(/\s/g, '') }),
      profile(`O-${n}`, { email: `own@${domain}`, first_name: 'Own', organization: `Acme Sales Own ${stamp}`, phone_number: personal }),
    ],
  });
  const api = await apiAs(playwright, adminEmail, MARKETING_HOST);
  const sync = async () => {
    const res = await api.post('/api/admin/integrations/klaviyo/sync', { timeout: 120_000 });
    expect(res.status()).toBe(200);
    return res.json();
  };
  try {
    expect((await api.put('/api/admin/integrations/klaviyo', { data: { key } })).status()).toBe(200);
    const saved = await api.patch('/api/admin/integrations/klaviyo', { data: { ignoredPhones: `${switchboard}\n${switchboard}\njunk` } });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).connection.ignoredPhones).toBe(switchboard);

    const first = await sync();
    expect(first.counts.CREATE).toBe(6);
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id } })).toBe(0);
    const leads = await prisma.user.findMany({
      where: { orgId: org.id, role: 'MENTEE' },
      select: { id: true, phone: true, company: { select: { contactEmail: true, contactPhone: true } } },
    });
    const byEmail = new Map(leads.map((l) => [l.company?.contactEmail, l]));
    // Four people with one number: nobody's own. The switchboard: ignored. The personal one: kept.
    for (let i = 1; i <= 4; i++) {
      expect(byEmail.get(`shared${i}@${domain}`)?.phone ?? null).toBeNull();
      expect(byEmail.get(`shared${i}@${domain}`)?.company?.contactPhone ?? null).toBeNull();
    }
    expect(byEmail.get(`board@${domain}`)?.phone ?? null).toBeNull();
    expect(byEmail.get(`own@${domain}`)?.phone).toBe(personal);

    // The candidate page reads the real address and offers no activation: a lead never signs in.
    const own = byEmail.get(`own@${domain}`)!;
    const detail = (await (await api.get(`/api/users/${own.id}`)).json()).user;
    expect(detail.leadRecord).toBe(true);
    expect(detail.contactEmail).toBe(`own@${domain}`);
    expect(detail.email).not.toBe(`own@${domain}`);

    // A rep (here: the admin in sales mode) takes one.
    const claim = await api.post(`/api/sales/pool/${own.id}/claim`);
    expect(claim.status()).toBe(201);
    const rel = await prisma.mentorshipRelation.findFirstOrThrow({ where: { menteeId: own.id } });
    expect(rel.mentorId).toBe(admin.id);
    expect(rel.pipelineStatus).toBe(firstStage);

    // The reset: the five untouched accounts go, the taken one stays — with its reason.
    const preview = await (await api.get('/api/admin/integrations/klaviyo/reset')).json();
    expect(preview.remove).toBe(5);
    expect(preview.keep).toBe(1);
    expect(preview.kept[0].name).toBe(`Acme Sales Own ${stamp}`);
    expect((await api.post('/api/admin/integrations/klaviyo/reset', { data: { expectRemove: 4 } })).status()).toBe(409);
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(6);
    const applied = await api.post('/api/admin/integrations/klaviyo/reset', { data: { expectRemove: 5 } });
    expect(applied.status()).toBe(200);
    expect((await applied.json()).removed).toBe(5);
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(1);
    expect(await prisma.user.count({ where: { orgId: org.id, role: 'MENTEE' } })).toBe(1);
    expect(await prisma.externalProfileLink.count({ where: { orgId: org.id } })).toBe(1);
    const conn = await prisma.externalConnection.findFirstOrThrow({ where: { orgId: org.id } });
    expect(conn.initialSyncDoneAt).toBeNull();
    expect(conn.profilesSince).toBeNull();

    // …and the next sync reads them all again, unassigned, under the same rules.
    const again = await sync();
    expect(again.counts.CREATE).toBe(5);
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(6);
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id } })).toBe(1);
    expect(await prisma.user.count({ where: { orgId: org.id, role: 'MENTEE', phone: shared } })).toBe(0);
  } finally {
    await api.dispose();
    await cleanupOrg(org.id, [adminEmail]);
  }
});
