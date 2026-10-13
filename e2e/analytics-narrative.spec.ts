import { test, expect } from '@playwright/test';
import type { Session } from 'next-auth';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { loadAdminAnalytics } from '../src/lib/adminAnalyticsData';
import { analyticsFacts } from '../src/lib/ai/narrativeRules';
import { hashInput } from '../src/lib/ai/artifacts';
import { resolvePipelineStages, stageLabel } from '../src/lib/pipelineStages';

// The "what changed" paragraph on /admin/analytics (#2046). An org of its own,
// so the figures the paragraph is keyed on are exactly this test's. CI has no
// provider key: a write attempt ends at a typed reason, costs nothing, and the
// card stays out of the way; a stored paragraph for the current figures shows
// on load without a call.

const PW = 'Narrative123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// The range the dashboard's default preset ("last 6 months") sends.
function sixMonths() {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 6);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

test('the paragraph is only ever read from storage or written on request, and cites only the figures', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const org = await prisma.organization.create({ data: { name: `Narrative ${stamp}`, slug: `narrative-${stamp}` } });
  const adminEmail = uniqueEmail('narr-admin');
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Narrative Admin', org.id);
  // An operator task behind the AI pack (#1738); the locked org is
  // e2e/ai-entitlement.spec.ts's business, this spec's org holds the pack.
  await setOrgFeature(org.id, 'AI_PACKAGE', true);
  try {
    const range = sixMonths();
    await signInAndSettle(page, adminEmail, PW, '/admin');
    const usageBefore = await prisma.aiUsage.count();

    // Nothing stored: GET says so and spends nothing.
    const empty = await (await page.request.get(`/api/admin/analytics/narrative?from=${range.from}&to=${range.to}`)).json();
    expect(empty).toMatchObject({ narrative: null, cached: false, reason: null });
    // A write attempt without a provider: a typed reason, no usage row.
    const asked = await (await page.request.post('/api/admin/analytics/narrative', { data: range })).json();
    expect(asked.narrative).toBeNull();
    expect(['not_configured', 'quota_exceeded']).toContain(asked.reason);
    expect(await prisma.aiUsage.count()).toBe(usageBefore);

    // A stored paragraph for exactly these figures, keyed as the route keys it.
    const session = { user: { id: admin.id, role: 'ADMIN', orgId: org.id } } as unknown as Session;
    const analytics = await loadAdminAnalytics(session, range, 'en');
    const stages = await resolvePipelineStages(org.id, 'en');
    const facts = analyticsFacts(analytics, (key) => stageLabel(stages, key, 'en'));
    await prisma.aiArtifact.create({
      data: {
        orgId: org.id,
        taskId: 'analytics_narrative',
        createdById: admin.id,
        inputHash: hashInput({ facts, locale: 'en' }),
        content: 'Nothing moved in this range; why is not visible in these figures.',
      },
    });
    const stored = await (await page.request.get(`/api/admin/analytics/narrative?from=${range.from}&to=${range.to}`)).json();
    expect(stored).toMatchObject({ cached: true, narrative: 'Nothing moved in this range; why is not visible in these figures.' });
    expect(await prisma.aiUsage.count()).toBe(usageBefore);

    // The dashboard opens on it, marked as AI.
    await page.goto('/admin/analytics');
    const card = page.getByTestId('analytics-narrative');
    await expect(card.getByTestId('analytics-narrative-text')).toHaveText('Nothing moved in this range; why is not visible in these figures.');
    await expect(card.getByTestId('ai-badge')).toBeVisible();
  } finally {
    await prisma.aiArtifact.deleteMany({ where: { orgId: org.id } });
    await cleanupByEmail(adminEmail);
    await prisma.orgEntitlement.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
