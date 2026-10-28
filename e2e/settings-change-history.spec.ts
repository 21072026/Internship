import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { gotoSettled, signInAndSettle, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { writeSetting } from '../src/lib/settingsWrite';

// Settings change history (#1623): every real change is one SettingChange row
// written by writeSetting() with the redacted before/after of #1699's
// redactedDiff(); a no-op save writes nothing; the history is the caller's org
// only; and "revert to inherited" DELETES the org row, so a later change at the
// global layer flows down again.

const PW = 'SettingsHistory123!';
const emails: string[] = [];
const orgIds: string[] = [];
const KEY = 'reminderDays';

let globalBefore: { value: string } | null = null;

test.beforeAll(async () => {
  globalBefore = await prisma.setting.findFirst({ where: { orgId: null, programId: null, key: KEY }, select: { value: true } });
});

test.afterAll(async () => {
  // Put the global row back exactly as it was.
  await prisma.setting.deleteMany({ where: { orgId: null, programId: null, key: KEY } });
  if (globalBefore) await prisma.setting.create({ data: { orgId: null, programId: null, key: KEY, value: globalBefore.value } });
  await prisma.settingChange.deleteMany({ where: { OR: [{ orgId: { in: orgIds } }, { orgId: null, key: KEY, actorId: null }] } });
  await prisma.setting.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.domainEvent.deleteMany({ where: { orgId: { in: orgIds } } });
  for (const email of emails) await cleanupByEmail(email);
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

async function tenant(label: string) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `History ${label} ${stamp}`, slug: `history-${label}-${stamp}` } });
  orgIds.push(org.id);
  const email = uniqueEmail(`settings-history-${label}`);
  emails.push(email);
  const user = await seedUser(email, PW, 'ADMIN', `History Admin ${label}`, { orgId: org.id });
  return { org, email, user };
}

test('a real change writes one history row, a no-op none, and the history is the caller’s org only', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const a = await tenant('a');
  const b = await tenant('b');
  const jarA = await playwright.request.newContext({ baseURL });
  const jarB = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(jarA, a.email, PW, { headers: freshIp('history-a') })).error).toBeNull();
    expect((await signInViaApi(jarB, b.email, PW, { headers: freshIp('history-b') })).error).toBeNull();

    await prisma.setting.create({ data: { orgId: a.org.id, key: 'require2fa', value: 'off' } });
    expect((await jarA.put('/api/admin/settings', { data: { require2fa: 'admins' } })).status()).toBe(200);
    const rows = await prisma.settingChange.findMany({ where: { orgId: a.org.id, key: 'require2fa' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oldValue: 'off', newValue: 'admins', actorId: a.user.id, programId: null });

    // Saving the same value again is not a change.
    expect((await jarA.put('/api/admin/settings', { data: { require2fa: 'admins' } })).status()).toBe(200);
    expect(await prisma.settingChange.count({ where: { orgId: a.org.id, key: 'require2fa' } })).toBe(1);

    // A `redact` key is stored masked — in the history and in the activity feed.
    expect((await jarA.put('/api/admin/settings', { data: { supportEmail: 'help@acme.example' } })).status()).toBe(200);
    const mail = await prisma.settingChange.findFirstOrThrow({ where: { orgId: a.org.id, key: 'supportEmail' } });
    expect(mail.newValue).toBe('[redacted]');
    const activity = await prisma.activityLog.findMany({ where: { orgId: a.org.id, targetType: 'Setting' } });
    expect(activity.map((r) => r.targetId).sort()).toEqual(['require2fa', 'supportEmail']);
    expect(JSON.stringify(activity)).not.toContain('help@acme.example');

    // The history: A sees its two rows; B sees none of them.
    const own = await (await jarA.get('/api/admin/settings/history')).json();
    expect(own.items.map((i: { key: string }) => i.key).sort()).toEqual(['require2fa', 'supportEmail']);
    expect(own.items.find((i: { key: string }) => i.key === 'require2fa')).toMatchObject({ oldValue: 'off', newValue: 'admins', scope: 'org' });
    const other = await (await jarB.get('/api/admin/settings/history')).json();
    expect(other.items).toEqual([]);
    // A forged orgId in the query string changes nothing.
    const forged = await (await jarB.get(`/api/admin/settings/history?orgId=${a.org.id}`)).json();
    expect(forged.items).toEqual([]);
  } finally {
    await jarA.dispose();
    await jarB.dispose();
  }
});

test('the settings page shows where a value comes from, its history, and reverts to the inherited value', async ({ page }) => {
  // A cold `next dev` compiles the settings route on first use; CI serves a build.
  test.setTimeout(180_000);
  const a = await tenant('ui');
  await signInAndSettle(page, a.email, PW, '/admin');
  await gotoSettled(page, '/admin/settings');

  await expect(page.getByTestId('settings-form')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  const badge = page.getByTestId(`setting-source-${KEY}`);
  await expect(badge).toHaveAttribute('data-source', /global|default/);

  // Change it here: one history row, badge "set here".
  const field = page.getByTestId(`setting-provenance-${KEY}`).locator('..').locator('input[type="number"]');
  await field.fill('21');
  await page.getByTestId('settings-form').locator('button[type="submit"]').first().click();
  await expect(badge).toHaveAttribute('data-source', 'org');
  const row = await prisma.setting.findFirstOrThrow({ where: { orgId: a.org.id, key: KEY } });
  expect(row.value).toBe('21');

  await page.getByTestId(`setting-history-toggle-${KEY}`).click();
  await expect(page.getByTestId(`setting-history-${KEY}`).getByTestId('setting-history-row')).toHaveCount(1);
  await expect(page.getByTestId(`setting-history-${KEY}`)).toContainText('21');

  // Revert: the org row is deleted, not overwritten.
  await page.getByTestId(`setting-revert-${KEY}`).click();
  await expect(badge).toHaveAttribute('data-source', /global|default/);
  expect(await prisma.setting.count({ where: { orgId: a.org.id, key: KEY } })).toBe(0);
  const changes = await prisma.settingChange.findMany({ where: { orgId: a.org.id, key: KEY }, orderBy: { createdAt: 'asc' } });
  expect(changes.map((c) => c.newValue)).toEqual(['21', null]);

  // A later change at the global layer now reaches this org.
  await writeSetting(KEY, '33', null);
  const res = await page.request.get('/api/admin/settings');
  const body = await res.json();
  expect(body.settings[KEY]).toBe('33');
  expect(body.sources[KEY]).toBe('global');
});
