import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { getAiQuota, runAiGated } from '../src/lib/aiGate';
import { setSetting } from '../src/lib/settings';
import { currentPeriod, periodRange } from '../src/lib/meteringRules';

// The monthly AI quota is per org (`aiMonthlyQuota` is a tenant setting, #1553),
// so the usage counted against it must be per org as well. It used to be a
// count of EVERY org's AiUsage rows this month — one tenant's calls spent
// another tenant's budget.
//
// Speaks to src/lib/aiGate.ts directly (no HTTP) so it holds whatever the
// server's MT_ENFORCE_ISOLATION flag is: the org comes from the caller's
// `orgId` argument, which is exactly what the routes pass. The provider is
// never contacted — `call` is a stub — but `isAiConfigured()` must read true for
// the gate to reach the call and meter it, so the key is set in THIS process.

const SCOPE = 'e2e_quota_per_org';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('two orgs meter their AI quota independently, by UTC month', async () => {
  const stamp = uniqueEmail('aiq').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const orgA = await prisma.organization.create({ data: { name: `AIQ A ${stamp}`, slug: `aiqa-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `AIQ B ${stamp}`, slug: `aiqb-${stamp}` } });
  const emailA = uniqueEmail('aiq-a');
  const userA = await seedUser(emailA, 'x', 'MENTEE', 'AIQ A User');
  await prisma.user.update({ where: { id: userA.id }, data: { orgId: orgA.id } });

  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = prevKey || 'e2e-stub-key';

  try {
    await setSetting('aiMonthlyQuota', '2', orgA.id);
    await setSetting('aiMonthlyQuota', '2', orgB.id);
    const call = async () => 'ok';

    // A spends its whole budget.
    for (let i = 0; i < 2; i++) {
      const r = await runAiGated({ scope: SCOPE, orgId: orgA.id, userId: userA.id, call });
      expect(r.ok).toBe(true);
    }
    const third = await runAiGated({ scope: SCOPE, orgId: orgA.id, userId: userA.id, call });
    expect(third).toEqual({ ok: false, reason: 'quota_exceeded' });

    // Every metered row is stamped with the org whose budget it spent.
    expect(await prisma.aiUsage.count({ where: { scope: SCOPE, orgId: orgA.id } })).toBe(2);

    // B is untouched by A's usage — both directions of the read.
    expect(await getAiQuota(orgA.id)).toMatchObject({ quota: 2, used: 2, remaining: 0 });
    expect(await getAiQuota(orgB.id)).toMatchObject({ quota: 2, used: 0, remaining: 2 });

    // The month is the UTC metering month: a B row one millisecond before the
    // 1st 00:00 UTC belongs to last month and is not counted.
    const { gte } = periodRange(currentPeriod());
    await prisma.aiUsage.create({
      data: { scope: SCOPE, orgId: orgB.id, createdAt: new Date(gte.getTime() - 1) },
    });
    expect((await getAiQuota(orgB.id)).used).toBe(0);

    const b = await runAiGated({ scope: SCOPE, orgId: orgB.id, call });
    expect(b.ok).toBe(true);
    expect(await getAiQuota(orgB.id)).toMatchObject({ used: 1, remaining: 1 });
    // …and B's call did not reach A's count either.
    expect((await getAiQuota(orgA.id)).used).toBe(2);
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    await prisma.aiUsage.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    await prisma.setting.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    await cleanupByEmail(emailA);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
