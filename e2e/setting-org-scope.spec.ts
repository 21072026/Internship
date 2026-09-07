import { test, expect } from '@playwright/test';
import { prisma, uniqueEmail } from './helpers/db';
import { getSetting, getSettings, setSetting, SETTING_DEFAULTS } from '../src/lib/settings';
import { runWithOrg } from '../src/lib/orgContext';

// Per-tenant settings with a global fallback (#1553).
//
// These exercise src/lib/settings.ts + Prisma directly (no HTTP), because the
// thing under test is the resolution ORDER — tenant row → global row (orgId =
// NULL) → SETTING_DEFAULTS — and that has to hold whatever the server's
// MT_ENFORCE_ISOLATION flag happens to be.

async function clearGlobal(key: string) {
  await prisma.setting.deleteMany({ where: { orgId: null, key } });
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('two orgs resolve their own values, and an unset key falls back to the global row then the default', async () => {
  const stamp = uniqueEmail('setting').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const orgA = await prisma.organization.create({ data: { name: `Set A ${stamp}`, slug: `seta-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `Set B ${stamp}`, slug: `setb-${stamp}` } });

  try {
    // Tenant overrides: A requires 2FA of its admins on a 50-call AI budget,
    // B leaves 2FA off and buys 900 calls.
    await setSetting('require2fa', 'admins', orgA.id);
    await setSetting('aiMonthlyQuota', '50', orgA.id);
    await setSetting('require2fa', 'off', orgB.id);
    await setSetting('aiMonthlyQuota', '900', orgB.id);

    // 1. Each org resolves its own row — one tenant's compliance policy is not
    //    the other's.
    expect(await getSetting('require2fa', orgA.id)).toBe('admins');
    expect(await getSetting('require2fa', orgB.id)).toBe('off');
    expect(await getSetting('aiMonthlyQuota', orgA.id)).toBe('50');
    expect(await getSetting('aiMonthlyQuota', orgB.id)).toBe('900');

    // 2. A key neither org overrode falls back to the GLOBAL row.
    await setSetting('retentionMonths', '36', null);
    expect(await getSetting('retentionMonths', orgA.id)).toBe('36');
    expect(await getSetting('retentionMonths', orgB.id)).toBe('36');
    expect(await getSetting('retentionMonths', null)).toBe('36');

    // …and a tenant row still wins over that global row.
    await setSetting('retentionMonths', '6', orgB.id);
    expect(await getSetting('retentionMonths', orgB.id)).toBe('6');
    expect(await getSetting('retentionMonths', orgA.id)).toBe('36');

    // 3. With no row at either level, the code default is the last resort.
    await clearGlobal('earlyAccessWindowDays');
    expect(await getSetting('earlyAccessWindowDays', orgA.id)).toBe(SETTING_DEFAULTS.earlyAccessWindowDays);

    // getSettings() layers the same way in one pass.
    const forA = await getSettings(orgA.id);
    expect(forA.require2fa).toBe('admins');
    expect(forA.retentionMonths).toBe('36');
    expect(forA.earlyAccessWindowDays).toBe(SETTING_DEFAULTS.earlyAccessWindowDays);

    const forB = await getSettings(orgB.id);
    expect(forB.require2fa).toBe('off');
    expect(forB.retentionMonths).toBe('6');

    // A brand-new tenant with no rows of its own inherits the global layer —
    // the whole reason the legacy rows stay at orgId = NULL.
    const fresh = await getSettings('org-that-has-no-rows');
    expect(fresh.retentionMonths).toBe('36');
    expect(fresh.require2fa).toBe(SETTING_DEFAULTS.require2fa);
  } finally {
    await clearGlobal('retentionMonths');
    await prisma.setting.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});

// The zero-argument signatures (~20 existing call sites) keep working: they
// resolve to whatever org the request bound, and to the global layer when none
// is bound. This is also the regression guard for the auto-filter: `Setting` is
// in TENANT_MODELS, so a naive scoped read would hide the orgId = NULL row and
// the fallback would silently become "code default".
test('the zero-argument readers follow the bound tenant and still see the global fallback', async () => {
  const stamp = uniqueEmail('setambient').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({ data: { name: `Set C ${stamp}`, slug: `setc-${stamp}` } });
  const prev = process.env.MT_ENFORCE_ISOLATION;

  try {
    // Start from a known global layer: an earlier spec may have left a row here.
    await clearGlobal('aiMonthlyQuota');
    await setSetting('aiMonthlyQuota', '77', org.id);
    await setSetting('retentionMonths', '24', null);

    process.env.MT_ENFORCE_ISOLATION = 'true';

    // Bound to the org: its own row wins…
    expect(await runWithOrg(org.id, () => getSetting('aiMonthlyQuota'))).toBe('77');
    // …and the global row is STILL reachable for a key the org never set,
    // even though the tenant middleware is live for this model.
    expect(await runWithOrg(org.id, () => getSetting('retentionMonths'))).toBe('24');
    expect((await runWithOrg(org.id, () => getSettings())).aiMonthlyQuota).toBe('77');

    // No org bound → the global layer alone, which is exactly what a
    // single-tenant installation reads.
    expect(await runWithOrg(null, () => getSetting('aiMonthlyQuota'))).toBe(SETTING_DEFAULTS.aiMonthlyQuota);
    expect(await runWithOrg(null, () => getSetting('retentionMonths'))).toBe('24');

    // A write with no org bound lands on the global row, not on a tenant's.
    await runWithOrg(null, () => setSetting('aiMonthlyQuota', '111'));
    expect(await getSetting('aiMonthlyQuota', null)).toBe('111');
    expect(await getSetting('aiMonthlyQuota', org.id)).toBe('77');

    // A write made while bound to the org can only touch that org's row.
    await runWithOrg(org.id, () => setSetting('aiMonthlyQuota', '88'));
    expect(await getSetting('aiMonthlyQuota', org.id)).toBe('88');
    expect(await getSetting('aiMonthlyQuota', null)).toBe('111');
  } finally {
    if (prev !== undefined) process.env.MT_ENFORCE_ISOLATION = prev;
    else delete process.env.MT_ENFORCE_ISOLATION;
    await clearGlobal('aiMonthlyQuota');
    await clearGlobal('retentionMonths');
    await prisma.setting.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
