import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// Lead attribution for a MARKETING tenant (#2421, story #2393).
//
// Two things are pinned here, and they are the two the issue is actually about.
//
//   1. REACHABILITY. /admin/sources is nav-gated on the `sourcing` capability
//      (src/lib/navLinks.ts) and the MARKETING vertical does not carry it
//      (src/lib/verticals.ts) — so before this slice a marketing admin had no
//      route to the attribution numbers at all. The decision taken was to reach
//      them from /admin/analytics (no capability tag, every vertical sees it)
//      rather than to widen `sourcing`, which would have handed a marketing
//      tenant the whole partner-institution intake module as a side effect.
//      The spec therefore asserts BOTH halves: no Sources nav entry, and the
//      attribution table on the analytics page.
//
//   2. THE COUNT, on this tenant's OWN stage catalogue. The org is provisioned
//      with the MARKETING preset, so its finished stage is DEAL_WON and the
//      canonical HIRED_660/EMPLOYED_700 exist nowhere in it — which is the whole
//      point: a hardcoded finished set reports 0% from every source here, for
//      ever (#1882), and a fixture left on the default catalogue would pass
//      either way. Both attribution endpoints are asserted, because only
//      /api/admin/sources still carried that literal before this slice.
//      "Creating an account with source X makes X's count 1" is the acceptance
//      criterion folded into this task from #2398 (T-8.1.3, the campaigns e2e
//      that has no subject because there is no Campaign model; `Source` carries
//      marketing attribution instead) — and the source here ALSO has a partner
//      login of its own pointing at it, the normal case on the sourcing screen,
//      which must not inflate the denominator into "2 leads, 50% conversion".
//
// The premium gate is deliberately still in the way: attribution is a paid
// report for every vertical (see the route header for the reasoning), so the
// spec turns `premiumAnalytics` on the way a paying tenant would and restores it
// in `finally` like its neighbours.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a MARKETING admin reaches lead attribution from /admin/analytics, and a source with one account counts 1', async ({
  page,
}) => {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `Attr MKT ${stamp}`, slug: `attr-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  // The tenant's own funnel: its finished stage is DEAL_WON, not HIRED_660.
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  const presetStages = templateStagePayload(preset, 'en').stages;
  await prisma.pipelineStage.createMany({
    data: presetStages.map((st) => ({
      orgId: org.id,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  const wonStage = presetStages.find((st) => st.isTerminal && !st.isOffPath);
  if (!wonStage) throw new Error('the marketing preset must have a won stage');

  const adminEmail = uniqueEmail('attr-admin');
  const repEmail = uniqueEmail('attr-rep');
  const leadEmail = uniqueEmail('attr-lead');
  const untrackedEmail = uniqueEmail('attr-untracked');
  const partnerEmail = uniqueEmail('attr-partner');
  const pw = 'AttrPass123';

  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Attribution Admin');
  const rep = await seedUser(repEmail, 'x', 'MENTOR', 'Attribution Rep');
  const lead = await seedUser(leadEmail, 'x', 'MENTEE', 'Attribution Lead');
  // A second lead with NO source, so the "untracked share" line — the number the
  // report exists to keep honest — has something to report.
  const untracked = await seedUser(untrackedEmail, 'x', 'MENTEE', 'Untracked Lead');

  const source = await prisma.source.create({ data: { name: `Trade fair ${stamp}`, orgId: org.id } });
  // The source's OWN login. On a SOURCE account `sourceId` records which source
  // the account speaks for, not who referred it (src/lib/referrer.ts) — so this
  // row must land in neither the numerator nor the denominator.
  const partner = await seedUser(partnerEmail, 'x', 'SOURCE', 'Attribution Partner');

  await prisma.user.updateMany({ where: { id: { in: [admin.id, rep.id, untracked.id] } }, data: { orgId: org.id } });
  await prisma.user.update({ where: { id: lead.id }, data: { orgId: org.id, sourceId: source.id } });
  await prisma.user.update({ where: { id: partner.id }, data: { orgId: org.id, sourceId: source.id } });

  // The lead is in the funnel and reached the finished stage of THIS org's
  // catalogue — so the source converted, not merely delivered.
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: rep.id, menteeId: lead.id, pipelineStatus: wonStage.key },
  });

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');

    // The screen that normally owns sources is not reachable for this vertical.
    const sidebar = page.locator('aside nav').first();
    await expect(sidebar.getByRole('link', { name: 'Sources', exact: true })).toHaveCount(0);

    // Attribution is a paid report for every vertical, so it is locked first.
    expect((await page.request.get('/api/admin/analytics/sources')).status()).toBe(403);
    expect(
      (await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } })).ok(),
    ).toBeTruthy();

    const res = await page.request.get('/api/admin/analytics/sources');
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      sources: { id: string; mentees: number; inPipeline: number; hired: number; conversionToHired: number }[];
      unsourced: number;
    };
    const mine = body.sources.find((s) => s.id === source.id);
    expect(mine).toBeTruthy();
    // One account created with source X ⇒ X's count is 1 (#2398 / T-8.1.3).
    expect(mine!.mentees).toBe(1);
    expect(mine!.inPipeline).toBe(1);
    expect(mine!.hired).toBe(1);
    expect(mine!.conversionToHired).toBe(100);
    // The unsourced bucket is still reported, and our untracked lead is in it.
    expect(body.unsourced).toBeGreaterThanOrEqual(1);

    // The other attribution endpoint agrees — the one that until this slice
    // counted against a hardcoded HIRED_660/EMPLOYED_700 (0% here, for ever) and
    // divided by an unfiltered count of everyone pointing at the source (which
    // includes the partner login above, i.e. 1/2 = 50%).
    const listed = await page.request.get('/api/admin/sources');
    expect(listed.ok()).toBeTruthy();
    const stat = ((await listed.json()) as {
      sources: { id: string; mentees: number; hired: number; conversion: number }[];
    }).sources.find((x) => x.id === source.id);
    expect(stat).toBeTruthy();
    expect(stat!.mentees).toBe(1);
    expect(stat!.hired).toBe(1);
    expect(stat!.conversion).toBe(100);

    // And the table is actually on the page a MARKETING admin can open.
    await page.goto('/admin/analytics');
    const card = page.getByTestId('source-conversion');
    await expect(card).toBeVisible({ timeout: 20_000 });
    // Dressed by the terminology overlay, not by the internship dictionary.
    await expect(card.getByText('Conversion by source', { exact: true })).toBeVisible();
    await expect(card.getByText('Source conversion', { exact: true })).toHaveCount(0);
    await expect(card.getByText('lead(s) have no source')).toBeVisible();

    const row = card.getByTestId(`source-row-${source.id}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('source-total')).toHaveText('1');
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await cleanupByEmail(partnerEmail);
    await cleanupByEmail(leadEmail);
    await cleanupByEmail(untrackedEmail);
    await cleanupByEmail(repEmail);
    await cleanupByEmail(adminEmail);
    await prisma.source.delete({ where: { id: source.id } }).catch(() => {});
    await prisma.setting.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
