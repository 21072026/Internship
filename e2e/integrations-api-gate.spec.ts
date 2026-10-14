import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// INTEGRATIONS_API (#1744): the public API, webhook subscriptions and issuing a
// key that can read the API are the plan's, not free. What stays open: the
// OpenAPI document, taking an integration DOWN (pause a webhook, revoke a key),
// and an account-event ingest key (companies:write), which is the tenant's own
// registered source feeding it, not the public API. Its own org, so the gate it toggles
// cannot race the specs that grant the feature to the default org.

const PW = 'IntegrationsGate123!';

test.describe('INTEGRATIONS_API gate', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('intgate-admin');
  let orgId = '';
  const keyNames: string[] = [];

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `IntGate ${stamp}`, slug: `intgate-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `IntGate Admin ${stamp}`, orgId);
  });

  test.afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { orgId } });
    await prisma.webhook.deleteMany({ where: { orgId } });
    await cleanupByEmail(admin);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('locked without the feature, open with it; taking an integration down always works', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    const raw = `icrm_${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.create({
      data: { name: `intgate-${stamp}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes: 'candidates:read', orgId },
    });
    const hook = await prisma.webhook.create({ data: { url: 'https://example.com/intgate', secret: 's', events: ['interaction.logged'], orgId } });
    const v1 = () => page.request.get('/api/v1/candidates', { headers: { authorization: `Bearer ${raw}` } });

    // The API: a live key of an unentitled org gets 403 naming the feature —
    // not data, and not a 401 that would read as "wrong key".
    const locked = await v1();
    expect(locked.status()).toBe(403);
    expect(await locked.json()).toMatchObject({ code: 'feature_locked', feature: 'INTEGRATIONS_API' });
    // The description of the API stays public.
    expect((await page.request.get('/api/v1/openapi.json', { headers: { authorization: '' } })).status()).toBe(200);

    // Setting up an integration is refused…
    const name = `intgate-new-${stamp}`;
    keyNames.push(name);
    const key = await page.request.post('/api/admin/api-keys', { data: { name, scopes: ['candidates:read'] } });
    expect(key.status()).toBe(403);
    expect(await key.json()).toMatchObject({ feature: 'INTEGRATIONS_API' });
    const wh = await page.request.post('/api/admin/webhooks', { data: { url: 'https://example.com/intgate2', events: ['interaction.logged'] } });
    expect(wh.status()).toBe(403);
    const reactivate = await page.request.patch(`/api/admin/webhooks?id=${hook.id}`, { data: { active: true } });
    expect(reactivate.status()).toBe(403);

    // …taking one down is not.
    const pause = await page.request.patch(`/api/admin/webhooks?id=${hook.id}`, { data: { active: false } });
    expect(pause.ok()).toBeTruthy();
    expect((await prisma.webhook.findUnique({ where: { id: hook.id } }))?.active).toBe(false);

    // The screen explains the refusal instead of swallowing it.
    await page.goto('/admin/integrations');
    const form = page.getByTestId('api-key-form');
    await form.getByTestId('api-key-name').fill(`intgate-ui-${stamp}`);
    await form.locator('button[type="submit"]').click();
    await expect(page.getByTestId('integrations-locked')).toBeVisible();

    // An account-event ingest key is the tenant's own feed, not the public API.
    const ingest = await page.request.post('/api/admin/api-keys', { data: { name: `intgate-ingest-${stamp}`, scopes: ['companies:write'] } });
    expect(ingest.status()).toBe(201);

    // With the feature, the same key and the same screens work.
    await setOrgFeature(orgId, 'INTEGRATIONS_API', true);
    expect((await v1()).status()).toBe(200);
    expect((await page.request.post('/api/admin/api-keys', { data: { name, scopes: ['candidates:read'] } })).status()).toBe(201);
    expect((await page.request.patch(`/api/admin/webhooks?id=${hook.id}`, { data: { active: true } })).ok()).toBeTruthy();
  });
});
