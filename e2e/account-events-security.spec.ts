import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash, createHmac, randomBytes } from 'crypto';
import { cleanupByEmail, prisma, seedUser, uniqueEmail } from './helpers/db';
import { asHost, gotoSettled, MARKETING_HOST, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// The account-event door's per-source hardening (#2978,
// docs/integrations/account-events.md § Security), end to end:
//
//   • IP ALLOWLIST — a source with a list refuses a client address outside it
//     with 403 `source_ip_not_allowed`, AFTER the key (no key is still the one
//     401); an address inside it, an IPv6 block included, is let through. The
//     client address is simulated the way the rate-limit specs do it: an
//     `X-Forwarded-For` whose rightmost entry is what the one trusted proxy saw
//     (the webServer runs at TRUSTED_PROXY_COUNT=1);
//   • REQUEST SIGNING — once an admin generated a secret: an unsigned request is
//     401 `bad_signature`, a correctly signed one is accepted, a tampered body
//     or a wrong secret is `bad_signature`, a timestamp > 300 s off is
//     `stale_signature`; after a rotation the old secret still works inside the
//     overlap and is refused once it has run out; switching signing off accepts
//     unsigned requests again. The batch route, dry run included, is held to
//     the same door;
//   • MANAGEMENT — the org's ADMIN lists, edits and rotates; the secret is in
//     the generating response only and never listed; a MENTOR is 403, another
//     org's ADMIN gets 404 for the source (and 403 naming the org), a super
//     admin of the world may act; every change is an AuditLog row with orgId.
//
// The tests tagged @smoke are the security boundary. Every slug and id is
// random per run and synthetic.

const STAMP = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const PW = 'SourceSec123!';
const SIGNED = `e2e-signed-${STAMP}`;
const FENCED = `e2e-fenced-${STAMP}`;
const OTHER = `e2e-other-${STAMP}`;
const H = asHost(MARKETING_HOST);
const E = {
  admin: uniqueEmail(`srcsec-admin-${STAMP}`),
  mentor: uniqueEmail(`srcsec-rep-${STAMP}`),
  otherAdmin: uniqueEmail(`srcsec-other-${STAMP}`),
  superAdmin: uniqueEmail(`srcsec-super-${STAMP}`),
  owner: uniqueEmail(`srcsec-owner-${STAMP}`),
};

let orgId: string;
let otherOrgId: string;
let superOrgId: string;
let writeKey: string;
let signedId: string;
let fencedId: string;
let otherSourceId: string;
const jars: Record<'admin' | 'mentor' | 'otherAdmin' | 'superAdmin', APIRequestContext | null> = {
  admin: null,
  mentor: null,
  otherAdmin: null,
  superAdmin: null,
};
let secret = '';

async function marketingOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales ${label} ${STAMP}`, slug: `srcsec-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  return org.id;
}

function envelope(over: Record<string, unknown> = {}) {
  return {
    event_id: `evt-${randomBytes(6).toString('hex')}`,
    schema_version: 1,
    event_type: 'plan_changed', // record-only: the door is what is under test
    occurred_at: new Date().toISOString(),
    external_id: `ext-${randomBytes(6).toString('hex')}`,
    ...over,
  };
}

const sign = (key: string, ts: string, body: string) => `sha256=${createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')}`;
const nowTs = () => String(Math.floor(Date.now() / 1000));

/** POST raw bytes, optionally signed, from `ip`. */
function post(
  request: APIRequestContext,
  slug: string,
  body: string,
  opts: { key?: string | null; sign?: { secret: string; ts?: string } | null; ip?: string; path?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': opts.ip ?? '192.0.2.10' };
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? writeKey}`;
  if (opts.sign) {
    const ts = opts.sign.ts ?? nowTs();
    headers['x-timestamp'] = ts;
    headers['x-signature'] = sign(opts.sign.secret, ts, body);
  }
  return request.post(`/api/integrations/${slug}/events${opts.path ?? ''}`, { headers, data: Buffer.from(body, 'utf8') });
}

test.describe('account events: source IP allowlist and request signing', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ playwright, baseURL }) => {
    orgId = await marketingOrg('a');
    otherOrgId = await marketingOrg('b');
    superOrgId = await marketingOrg('c');
    const owner = await seedUser(E.owner, PW, 'MENTOR', 'Source Owner', orgId);
    await prisma.setting.create({ data: { orgId, key: 'defaultLeadOwnerId', value: owner.id } });
    await seedUser(E.admin, PW, 'ADMIN', 'Source Admin', orgId);
    await seedUser(E.mentor, PW, 'MENTOR', 'Source Rep', orgId);
    await seedUser(E.otherAdmin, PW, 'ADMIN', 'Other Admin', otherOrgId);
    const sup = await seedUser(E.superAdmin, PW, 'ADMIN', 'World Operator', superOrgId);
    await prisma.user.update({ where: { id: sup.id }, data: { isSuperAdmin: true } });

    writeKey = `icrm_${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.create({
      data: { name: `e2e-srcsec-${STAMP}`, hashedKey: createHash('sha256').update(writeKey).digest('hex'), scopes: 'companies:write', orgId },
    });
    signedId = (await prisma.integrationSource.create({ data: { orgId, slug: SIGNED, label: 'Signed feed' } })).id;
    fencedId = (await prisma.integrationSource.create({ data: { orgId, slug: FENCED, label: 'Fenced feed' } })).id;
    otherSourceId = (await prisma.integrationSource.create({ data: { orgId: otherOrgId, slug: OTHER, label: 'Other feed' } })).id;

    for (const who of ['admin', 'mentor', 'otherAdmin', 'superAdmin'] as const) {
      const jar = await playwright.request.newContext({ baseURL, extraHTTPHeaders: H });
      const r = await signInViaApi(jar, E[who], PW, { host: MARKETING_HOST, headers: freshIp(`srcsec-${who}`) });
      expect(r.ok, `sign-in ${who}: ${r.error}`).toBe(true);
      jars[who] = jar;
    }
  });

  test.afterAll(async () => {
    for (const jar of Object.values(jars)) await jar?.dispose();
    const orgIds = [orgId, otherOrgId, superOrgId].filter(Boolean);
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.integrationEvent.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.integrationSource.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.company.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.apiKey.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.setting.deleteMany({ where: { orgId: { in: orgIds } } });
    for (const email of Object.values(E)) await cleanupByEmail(email);
    await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  });

  test('a source with neither protection behaves as before', async ({ request }) => {
    const res = await post(request, SIGNED, JSON.stringify(envelope()));
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).outcome).toBe('recorded');
  });

  test('management: who may list, edit and rotate', { tag: '@smoke' }, async ({ request }) => {
    // Anonymous and a MENTOR: no.
    expect((await request.get('/api/admin/integration-sources', { headers: H })).status()).toBe(401);
    expect((await jars.mentor!.get('/api/admin/integration-sources')).status()).toBe(403);
    expect((await jars.mentor!.post(`/api/admin/integration-sources/${signedId}/signing-secret`)).status()).toBe(403);

    // The org's admin sees its own sources, never another org's, and no secret.
    const list = await jars.admin!.get('/api/admin/integration-sources');
    expect(list.status()).toBe(200);
    const body = await list.json();
    const slugs = body.sources.map((s: { slug: string }) => s.slug);
    expect(slugs).toEqual(expect.arrayContaining([SIGNED, FENCED]));
    expect(slugs).not.toContain(OTHER);
    const signedRow = body.sources.find((s: { slug: string }) => s.slug === SIGNED);
    expect(signedRow.lastEventAt).not.toBeNull(); // the baseline event above
    expect(signedRow.signing).toEqual({ enabled: false, rotatedAt: null, previousValidUntil: null });

    // Another org's admin: the source is a 404 (never confirmed), naming the org a 403.
    expect((await jars.otherAdmin!.patch(`/api/admin/integration-sources/${signedId}`, { data: { enabled: false } })).status()).toBe(404);
    expect((await jars.otherAdmin!.post(`/api/admin/integration-sources/${signedId}/signing-secret`)).status()).toBe(404);
    expect((await jars.otherAdmin!.delete(`/api/admin/integration-sources/${signedId}/signing-secret`)).status()).toBe(404);
    expect((await jars.otherAdmin!.get(`/api/admin/integration-sources?orgId=${orgId}`)).status()).toBe(403);
    expect((await jars.admin!.patch(`/api/admin/integration-sources/${otherSourceId}`, { data: { enabled: false } })).status()).toBe(404);
    expect((await jars.admin!.patch(`/api/admin/integration-sources/nope-${STAMP}`, { data: { enabled: false } })).status()).toBe(404);
    const untouched = await prisma.integrationSource.findUniqueOrThrow({ where: { id: signedId } });
    expect(untouched.enabled).toBe(true);
    expect(untouched.signingSecret).toBeNull();

    // A super admin of the world may act on the org.
    const superList = await jars.superAdmin!.get(`/api/admin/integration-sources?orgId=${orgId}`);
    expect(superList.status()).toBe(200);
    expect((await superList.json()).sources.map((s: { slug: string }) => s.slug)).toContain(FENCED);
    const sup = await jars.superAdmin!.patch(`/api/admin/integration-sources/${fencedId}`, { data: { enabled: false } });
    expect(sup.status()).toBe(200);
    expect((await sup.json()).source.enabled).toBe(false);
    const back = await jars.admin!.patch(`/api/admin/integration-sources/${fencedId}`, { data: { enabled: true } });
    expect((await back.json()).source.enabled).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { targetId: fencedId }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['integration_source.disabled', 'integration_source.enabled']);
    expect(audits.every((a) => a.orgId === orgId)).toBe(true);
  });

  test('an invalid allowlist is refused whole, naming each entry', async () => {
    const res = await jars.admin!.patch(`/api/admin/integration-sources/${fencedId}`, {
      data: { allowedIps: '203.0.113.0/24, 10.0.0.1/8, nonsense, 0.0.0.0/0' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_allowed_ips');
    expect(body.errors).toEqual([
      { value: '10.0.0.1/8', code: 'host_bits' },
      { value: 'nonsense', code: 'invalid' },
      { value: '0.0.0.0/0', code: 'too_broad' },
    ]);
    expect((await prisma.integrationSource.findUniqueOrThrow({ where: { id: fencedId } })).allowedIps).toBeNull();
  });

  test('IP allowlist: an address outside it is refused after the key, inside it accepted', { tag: '@smoke' }, async ({ request }) => {
    const set = await jars.admin!.patch(`/api/admin/integration-sources/${fencedId}`, {
      data: { allowedIps: '203.0.113.0/24\n2001:DB8::/32' },
    });
    expect(set.status()).toBe(200);
    expect((await set.json()).source.allowedIps).toEqual(['203.0.113.0/24', '2001:db8::/32']);
    const audit = await prisma.auditLog.findFirst({ where: { targetId: fencedId, action: 'integration_source.allowed_ips' } });
    expect(audit?.orgId).toBe(orgId);

    const body = JSON.stringify(envelope());
    // No key: the door's one 401, whatever the address — nothing about the list leaks.
    expect((await post(request, FENCED, body, { key: null, ip: '198.51.100.4' })).status()).toBe(401);
    // A working key from outside the list.
    const refused = await post(request, FENCED, body, { ip: '198.51.100.4' });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('source_ip_not_allowed');
    // Client-written text on the left of the proxy's entry buys nothing.
    const spoofed = await post(request, FENCED, body, { ip: '203.0.113.9, 198.51.100.4' });
    expect(spoofed.status()).toBe(403);
    // The batch route is the same door.
    const batchRefused = await post(request, FENCED, JSON.stringify({ events: [envelope()], dry_run: true }), { ip: '198.51.100.4', path: '/batch' });
    expect(batchRefused.status()).toBe(403);
    expect((await batchRefused.json()).code).toBe('source_ip_not_allowed');
    expect(await prisma.integrationEvent.count({ where: { orgId, provider: FENCED } })).toBe(0);

    // Inside: IPv4 and IPv6.
    const ok4 = await post(request, FENCED, body, { ip: '203.0.113.9' });
    expect(ok4.status(), await ok4.text()).toBe(200);
    const ok6 = await post(request, FENCED, JSON.stringify(envelope()), { ip: '2001:db8:1::5' });
    expect(ok6.status(), await ok6.text()).toBe(200);

    // Cleared: any address again.
    const cleared = await jars.admin!.patch(`/api/admin/integration-sources/${fencedId}`, { data: { allowedIps: null } });
    expect((await cleared.json()).source.allowedIps).toEqual([]);
    expect((await post(request, FENCED, JSON.stringify(envelope()), { ip: '198.51.100.4' })).status()).toBe(200);
  });

  test('signing: generated once, then every request must be signed', { tag: '@smoke' }, async ({ request }) => {
    const gen = await jars.admin!.post(`/api/admin/integration-sources/${signedId}/signing-secret`);
    expect(gen.status()).toBe(200);
    const g = await gen.json();
    secret = g.secret;
    expect(secret).toMatch(/^isig_[0-9a-f]{64}$/);
    expect(g.source.signing.enabled).toBe(true);
    expect(g.source.signing.previousValidUntil).toBeNull();
    // Sealed at rest, never listed again.
    const row = await prisma.integrationSource.findUniqueOrThrow({ where: { id: signedId } });
    expect(row.signingSecret).toBeTruthy();
    expect(row.signingSecret).not.toContain(secret.slice(5));
    const listed = await (await jars.admin!.get('/api/admin/integration-sources')).text();
    expect(listed).not.toContain(secret.slice(5));
    expect(listed).not.toContain(row.signingSecret!);
    const audit = await prisma.auditLog.findFirst({ where: { targetId: signedId, action: 'integration_source.signing_enabled' } });
    expect(audit?.orgId).toBe(orgId);
    expect(audit?.detail ?? '').not.toContain(secret.slice(5));

    const body = JSON.stringify(envelope());
    // Unsigned.
    const unsigned = await post(request, SIGNED, body);
    expect(unsigned.status()).toBe(401);
    expect((await unsigned.json()).code).toBe('bad_signature');
    // No key still answers the key's 401, not the signature's.
    const noKey = await post(request, SIGNED, body, { key: null, sign: { secret } });
    expect(noKey.status()).toBe(401);
    expect((await noKey.json()).code).toBeUndefined();
    // Wrong secret.
    const wrong = await post(request, SIGNED, body, { sign: { secret: `isig_${'0'.repeat(64)}` } });
    expect((await wrong.json()).code).toBe('bad_signature');
    // Tampered body: signed over one body, another one sent.
    const ts = nowTs();
    const tampered = await request.post(`/api/integrations/${SIGNED}/events`, {
      headers: {
        authorization: `Bearer ${writeKey}`,
        'content-type': 'application/json',
        'x-forwarded-for': '192.0.2.10',
        'x-timestamp': ts,
        'x-signature': sign(secret, ts, body),
      },
      data: Buffer.from(body.replace('plan_changed', 'converted'), 'utf8'),
    });
    expect(tampered.status()).toBe(401);
    expect((await tampered.json()).code).toBe('bad_signature');
    // Stale: correctly signed, ten minutes old — and ten minutes ahead.
    const stale = await post(request, SIGNED, body, { sign: { secret, ts: String(Math.floor(Date.now() / 1000) - 600) } });
    expect(stale.status()).toBe(401);
    expect((await stale.json()).code).toBe('stale_signature');
    const ahead = await post(request, SIGNED, body, { sign: { secret, ts: String(Math.floor(Date.now() / 1000) + 600) } });
    expect((await ahead.json()).code).toBe('stale_signature');
    expect(await prisma.integrationEvent.count({ where: { orgId, provider: SIGNED, eventId: JSON.parse(body).event_id } })).toBe(0);

    // Valid.
    const ok = await post(request, SIGNED, body, { sign: { secret } });
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await ok.json()).outcome).toBe('recorded');
    // A replay of the same signed request inside the window is a duplicate, nothing more.
    const replay = await post(request, SIGNED, body, { sign: { secret } });
    expect((await replay.json()).outcome).toBe('duplicate');
  });

  test('signing: the batch route and its dry run are held to the same signature', { tag: '@smoke' }, async ({ request }) => {
    const batch = JSON.stringify({ events: [envelope()], dry_run: true });
    const unsigned = await post(request, SIGNED, batch, { path: '/batch' });
    expect(unsigned.status()).toBe(401);
    expect((await unsigned.json()).code).toBe('bad_signature');
    const stale = await post(request, SIGNED, batch, { path: '/batch', sign: { secret, ts: String(Math.floor(Date.now() / 1000) - 301) } });
    expect((await stale.json()).code).toBe('stale_signature');
    const ok = await post(request, SIGNED, batch, { path: '/batch', sign: { secret } });
    expect(ok.status(), await ok.text()).toBe(200);
    const res = await ok.json();
    expect(res.dry_run).toBe(true);
    expect(res.results).toHaveLength(1);
  });

  test('rotation: the old secret works inside the overlap only', { tag: '@smoke' }, async ({ request }) => {
    const old = secret;
    const rot = await jars.admin!.post(`/api/admin/integration-sources/${signedId}/signing-secret`);
    expect(rot.status()).toBe(200);
    const r = await rot.json();
    expect(r.secret).not.toBe(old);
    const until = new Date(r.source.signing.previousValidUntil).getTime();
    expect(until - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
    expect(until - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
    secret = r.secret;

    expect((await post(request, SIGNED, JSON.stringify(envelope()), { sign: { secret } })).status()).toBe(200);
    expect((await post(request, SIGNED, JSON.stringify(envelope()), { sign: { secret: old } })).status()).toBe(200);

    // The overlap runs out.
    await prisma.integrationSource.update({ where: { id: signedId }, data: { signingPreviousUntil: new Date(Date.now() - 1000) } });
    const expired = await post(request, SIGNED, JSON.stringify(envelope()), { sign: { secret: old } });
    expect(expired.status()).toBe(401);
    expect((await expired.json()).code).toBe('bad_signature');
    expect((await post(request, SIGNED, JSON.stringify(envelope()), { sign: { secret } })).status()).toBe(200);

    const audits = await prisma.auditLog.findMany({ where: { targetId: signedId, action: 'integration_source.signing_rotated' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].orgId).toBe(orgId);
  });

  test('the admin screen: the card lists the sources and shows a rotated secret once', async ({ browser }) => {
    const context = await browser.newContext({ storageState: await jars.admin!.storageState(), extraHTTPHeaders: H });
    try {
      const page = await context.newPage();
      page.on('dialog', (d) => void d.accept());
      await gotoSettled(page, '/admin/integrations');
      const card = page.getByTestId('integration-sources');
      await expect(card).toBeVisible();
      await expect(card.getByTestId(`integration-source-${SIGNED}`)).toBeVisible();
      await expect(card.getByTestId(`integration-source-${OTHER}`)).toHaveCount(0);
      await expect(card.getByTestId(`integration-source-signing-${SIGNED}`)).toContainText(/./);
      await expect(card.getByTestId(`integration-source-last-${SIGNED}`)).not.toBeEmpty();

      await card.getByTestId(`integration-source-rotate-${SIGNED}`).click();
      const shown = card.getByTestId('integration-source-secret-value');
      await expect(shown).toHaveText(/^isig_[0-9a-f]{64}$/);
      secret = (await shown.textContent()) ?? '';
      await expect(card.getByTestId(`integration-source-previous-${SIGNED}`)).toBeVisible();

      // Reloaded, the secret is gone for good.
      await page.reload();
      await expect(card.getByTestId(`integration-source-${SIGNED}`)).toBeVisible();
      await expect(card.getByTestId('integration-source-secret-value')).toHaveCount(0);
      expect(await page.content()).not.toContain(secret.slice(5));

      // The allowlist is edited in place and saved canonically.
      await card.getByTestId(`integration-source-ips-${FENCED}`).fill('2001:0DB8::/32, 192.0.2.0/24');
      await card.getByTestId(`integration-source-ips-save-${FENCED}`).click();
      await expect(card.getByTestId(`integration-source-ips-note-${FENCED}`)).toBeVisible();
      await expect(card.getByTestId(`integration-source-ips-${FENCED}`)).toHaveValue('2001:db8::/32\n192.0.2.0/24');
      await card.getByTestId(`integration-source-ips-${FENCED}`).fill('');
      await card.getByTestId(`integration-source-ips-save-${FENCED}`).click();
      await expect.poll(async () => (await prisma.integrationSource.findUniqueOrThrow({ where: { id: fencedId } })).allowedIps).toBeNull();
    } finally {
      await context.close();
    }
  });

  test('switching signing off accepts unsigned requests again', async ({ request }) => {
    const off = await jars.admin!.delete(`/api/admin/integration-sources/${signedId}/signing-secret`);
    expect(off.status()).toBe(200);
    expect((await off.json()).source.signing.enabled).toBe(false);
    const row = await prisma.integrationSource.findUniqueOrThrow({ where: { id: signedId } });
    expect([row.signingSecret, row.signingSecretPrevious, row.signingPreviousUntil]).toEqual([null, null, null]);
    expect((await post(request, SIGNED, JSON.stringify(envelope()))).status()).toBe(200);
    expect(await prisma.auditLog.count({ where: { targetId: signedId, action: 'integration_source.signing_disabled', orgId } })).toBe(1);
  });
});
