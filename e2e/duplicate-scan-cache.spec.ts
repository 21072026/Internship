import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The duplicate scan reuses its last result while the org's mentees are
// unchanged (#1434, src/lib/duplicateScanCache.ts). The part that must never
// go wrong: a merge or an edit is seen by the very next scan, never a stale
// pair that no longer exists or a missing one that just appeared.
test('the scan sees a merge and an edit on the next request', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const org = await prisma.organization.create({ data: { name: `DupCache ${stamp}`, slug: `dupcache-${stamp}` } });
  const api = await playwright.request.newContext({ baseURL });
  try {
    const pw = 'DupCache123!';
    const adminEmail = uniqueEmail('dupcache-admin');
    await seedUser(adminEmail, pw, 'ADMIN', `DupCache Admin ${stamp}`, org.id);
    const primary = await seedUser(uniqueEmail('dupcache-a'), pw, 'MENTEE', `Quorinda Vell ${stamp}`, org.id);
    const twin = await seedUser(uniqueEmail('dupcache-b'), pw, 'MENTEE', `Quorinda Vell ${stamp}`, org.id);
    const other = await seedUser(uniqueEmail('dupcache-c'), pw, 'MENTEE', `Zebulon Krast ${stamp}`, org.id);
    expect((await signInViaApi(api, adminEmail, pw)).ok).toBe(true);

    const pairIds = async () =>
      ((await (await api.get('/api/admin/duplicates')).json()).pairs as { a: { id: string }; b: { id: string } }[]).map((p) =>
        [p.a.id, p.b.id].sort().join('+'),
      );
    const key = (x: string, y: string) => [x, y].sort().join('+');

    expect(await pairIds()).toEqual([key(primary.id, twin.id)]);
    expect(await pairIds()).toEqual([key(primary.id, twin.id)]); // the second call is served from the cache

    // An edit that creates a new pair moves the fingerprint (updatedAt).
    await prisma.user.update({ where: { id: other.id }, data: { fullName: `Quorinda Vell ${stamp}` } });
    const afterEdit = await pairIds();
    expect(afterEdit).toHaveLength(3);
    expect(afterEdit).toContain(key(primary.id, other.id));

    // Archiving moves the fingerprint too: the next scan shows the row as archived.
    const archived = await api.patch(`/api/users/${other.id}`, { data: { isActive: false } });
    expect(archived.ok(), await archived.text()).toBe(true);
    const afterArchive = (await (await api.get('/api/admin/duplicates')).json()).pairs as { a: { id: string; isActive: boolean }; b: { id: string; isActive: boolean } }[];
    const otherRow = afterArchive.flatMap((p) => [p.a, p.b]).find((u) => u.id === other.id);
    expect(otherRow?.isActive).toBe(false);

    // A merge removes a row: the merged pairs are gone on the next scan.
    const merged = await api.post('/api/admin/duplicates/merge', {
      data: { primaryId: primary.id, duplicateId: twin.id, confirmName: twin.fullName, adminPassword: pw },
    });
    expect(merged.ok()).toBe(true);
    expect(await pairIds()).toEqual([key(primary.id, other.id)]);
  } finally {
    await api.dispose();
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
