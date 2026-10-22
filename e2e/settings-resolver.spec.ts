import { test, expect } from '@playwright/test';
import { prisma, uniqueEmail } from './helpers/db';
import { setSetting, getSetting } from '../src/lib/settings';
import { resolveProgramScope, resolveSetting, resolveSettings, withSettingsCache } from '../src/lib/settingsResolver';
import { currentQueryCount, withRequestContext } from '../src/lib/requestContext';

// The settings chain against the database (#1619): programme → org → global →
// default, through the one writer and the typed, cached reader. Speaks to the
// modules directly (no HTTP), so it holds whatever the server's flags are.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function twoOrgsAndAProgramme() {
  const stamp = uniqueEmail('set').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const orgA = await prisma.organization.create({ data: { name: `Settings A ${stamp}`, slug: `seta-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `Settings B ${stamp}`, slug: `setb-${stamp}` } });
  const programme = await prisma.cohort.create({ data: { name: `Programme ${stamp}`, orgId: orgA.id } });
  const foreign = await prisma.cohort.create({ data: { name: `Foreign ${stamp}`, orgId: orgB.id } });
  return { orgA: orgA.id, orgB: orgB.id, programme: programme.id, foreign: foreign.id };
}

async function cleanup(ids: { orgA: string; orgB: string }) {
  // Setting and Cohort rows go with their org (onDelete: Cascade on Setting;
  // the cohorts are deleted explicitly first).
  await prisma.setting.deleteMany({ where: { orgId: { in: [ids.orgA, ids.orgB] } } });
  await prisma.cohort.deleteMany({ where: { orgId: { in: [ids.orgA, ids.orgB] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ids.orgA, ids.orgB] } } });
}

test('each layer of the chain wins in turn, parsed to its type', { tag: '@smoke' }, async () => {
  const ids = await twoOrgsAndAProgramme();
  // The global row is shared by every test and every tenant; restore it after.
  const globalBefore = await prisma.setting.findMany({ where: { orgId: null, programId: null, key: 'lateCancelHours' } });
  try {
    const scope = { orgId: ids.orgA, programId: ids.programme };
    await prisma.setting.deleteMany({ where: { orgId: null, key: 'lateCancelHours' } });

    expect(await resolveSetting('lateCancelHours', scope)).toBe(24);
    await setSetting('lateCancelHours', '36', null);
    expect(await resolveSetting('lateCancelHours', scope)).toBe(36);
    await setSetting('lateCancelHours', '12', ids.orgA);
    expect(await resolveSetting('lateCancelHours', scope)).toBe(12);
    await setSetting('lateCancelHours', '2', ids.orgA, { programId: ids.programme });
    expect(await resolveSetting('lateCancelHours', scope)).toBe(2);

    const all = await resolveSettings(scope);
    expect(all.values.lateCancelHours).toBe(2);
    expect(all.sources.lateCancelHours).toBe('program');
    expect(all.values.weeklyDigest).toBe(true);
    expect(all.sources.weeklyDigest === 'default' || all.sources.weeklyDigest === 'global').toBe(true);

    // The org-level readers never see a programme row.
    expect(await getSetting('lateCancelHours', ids.orgA)).toBe('12');
    // Another tenant inherits the global row, never orgA's rows.
    expect(await resolveSetting('lateCancelHours', { orgId: ids.orgB })).toBe(36);

    // Peel the layers off again, top down.
    await prisma.setting.deleteMany({ where: { orgId: ids.orgA, programId: ids.programme } });
    expect(await resolveSetting('lateCancelHours', scope)).toBe(12);
    await prisma.setting.deleteMany({ where: { orgId: ids.orgA, key: 'lateCancelHours' } });
    expect(await resolveSetting('lateCancelHours', scope)).toBe(36);
    await prisma.setting.deleteMany({ where: { orgId: null, key: 'lateCancelHours' } });
    expect(await resolveSetting('lateCancelHours', scope)).toBe(24);
  } finally {
    await prisma.setting.deleteMany({ where: { orgId: null, key: 'lateCancelHours' } });
    for (const r of globalBefore) await prisma.setting.create({ data: { orgId: null, key: r.key, value: r.value } });
    await cleanup(ids);
  }
});

test('a second org-level write updates the row; the NULL-distinct index cannot be relied on', { tag: '@smoke' }, async () => {
  // MySQL treats NULLs as distinct in a unique index, so @@unique([orgId,
  // programId, key]) does not stop two (orgA, NULL, key) rows. setSetting's
  // find-then-write is what keeps the org layer single — pinned here.
  const ids = await twoOrgsAndAProgramme();
  try {
    await setSetting('boardWipLimit', '5', ids.orgA);
    await setSetting('boardWipLimit', '6', ids.orgA);
    const rows = await prisma.setting.findMany({ where: { orgId: ids.orgA, programId: null, key: 'boardWipLimit' } });
    expect(rows.map((r) => r.value)).toEqual(['6']);

    await setSetting('boardWipLimit', '9', ids.orgA, { programId: ids.programme });
    await setSetting('boardWipLimit', '10', ids.orgA, { programId: ids.programme });
    expect(await prisma.setting.count({ where: { orgId: ids.orgA, key: 'boardWipLimit' } })).toBe(2);
  } finally {
    await cleanup(ids);
  }
});

test('the writer refuses a programme row it cannot vouch for', { tag: '@smoke' }, async () => {
  const ids = await twoOrgsAndAProgramme();
  try {
    // A key that binds the whole tenant has no programme layer.
    await expect(setSetting('require2fa', 'all', ids.orgA, { programId: ids.programme })).rejects.toThrow(/no per-programme row/);
    // Another tenant's programme.
    await expect(setSetting('reminderDays', '3', ids.orgA, { programId: ids.foreign })).rejects.toThrow(/not found in this org/);
    // No org.
    await expect(setSetting('reminderDays', '3', null, { programId: ids.programme })).rejects.toThrow(/needs its org/);
    expect(await prisma.setting.count({ where: { programId: { in: [ids.programme, ids.foreign] } } })).toBe(0);
  } finally {
    await cleanup(ids);
  }
});

test('200 reads in one request cost one query per scope, and a write is seen at once', { tag: '@smoke' }, async () => {
  const ids = await twoOrgsAndAProgramme();
  try {
    await setSetting('reminderDays', '9', ids.orgA);
    await withRequestContext('settings-cache-test', async () => {
      const before = currentQueryCount() ?? 0;
      for (let i = 0; i < 200; i++) {
        expect(await resolveSetting('reminderDays', { orgId: ids.orgA })).toBe(9);
        await resolveSetting('blindReview', { orgId: ids.orgA, programId: ids.programme });
      }
      expect((currentQueryCount() ?? 0) - before).toBe(2);

      // The memo drops itself after a write, so the request reads its own write.
      await setSetting('reminderDays', '4', ids.orgA);
      expect(await resolveSetting('reminderDays', { orgId: ids.orgA })).toBe(4);
    });

    // A job without a request binds its own cache the same way.
    await withSettingsCache(async () => {
      const values = await Promise.all(Array.from({ length: 50 }, () => resolveSetting('reminderDays', { orgId: ids.orgA })));
      expect(new Set(values)).toEqual(new Set([4]));
    });
  } finally {
    await cleanup(ids);
  }
});

test('resolveProgramScope reads both ids off a relation or a programme', async () => {
  const ids = await twoOrgsAndAProgramme();
  try {
    expect(await resolveProgramScope({ cohortId: ids.programme })).toEqual({ orgId: ids.orgA, programId: ids.programme });
    expect(await resolveProgramScope({ cohortId: 'does-not-exist' })).toBeNull();
  } finally {
    await cleanup(ids);
  }
});
