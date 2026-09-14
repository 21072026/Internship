import { test, expect } from '@playwright/test';
import { prisma, seedCustomPipelineOrg, cleanupCustomPipelineOrg } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { outcomeStageKeysFrom } from '../src/lib/pipelineStages';
import { defaultPipelineStages } from '../src/lib/pipeline';

/**
 * The five paid reports must count a tenant's OWN finished stage (#1882).
 *
 * Cohort comparison, source conversion, the cross-program benchmark, the admin
 * headline conversion and mentor analytics each carried their own
 * `new Set(['HIRED_660','EMPLOYED_700'])`. A customer that renamed its pipeline
 * (#747) holds neither key, so all five answered "0 placed, 0%" — not an error,
 * not an empty state, a confident and wrong number on a report we charge for.
 *
 * The fixture is the renamed-stage tenant every other spec lacks: six stages
 * keyed `STAGE_A`…`STAGE_F`, and one relation that actually travelled
 * `STAGE_A → STAGE_F`. On `main` every assertion below reads zero.
 *
 * The last test is the regression half: an org on the built-in catalogue must
 * still resolve to exactly the two literals the routes hardcoded, so nothing
 * about a default deployment's numbers moves.
 */

const PASSWORD = 'OutcomeStage123!';

let seeded: Awaited<ReturnType<typeof seedCustomPipelineOrg>>;
let cohortId = '';
let sourceId = '';
let sourceName = '';
let mentorId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  seeded = await seedCustomPipelineOrg('outcome-stage', PASSWORD);

  // The cohort and source reports need the seeded relation to belong to one of
  // each; the fixture deliberately seeds only the pipeline shape.
  const cohort = await prisma.cohort.create({
    data: { orgId: seeded.org.id, name: `Outcome Cohort ${Date.now()}`, term: '2026' },
  });
  cohortId = cohort.id;
  sourceName = `Outcome Source ${Date.now()}`;
  const source = await prisma.source.create({ data: { orgId: seeded.org.id, name: sourceName } });
  sourceId = source.id;

  const relation = await prisma.mentorshipRelation.update({
    where: { id: seeded.relationId },
    data: { cohortId },
    select: { mentorId: true, menteeId: true },
  });
  mentorId = relation.mentorId;
  await prisma.user.update({ where: { id: relation.menteeId }, data: { sourceId } });
});

test.afterAll(async () => {
  if (cohortId) {
    await prisma.mentorshipRelation.updateMany({ where: { cohortId }, data: { cohortId: null } });
    await prisma.cohort.deleteMany({ where: { id: cohortId } });
  }
  if (sourceId) {
    await prisma.user.updateMany({ where: { sourceId }, data: { sourceId: null } });
    await prisma.source.deleteMany({ where: { id: sourceId } });
  }
  if (seeded) await cleanupCustomPipelineOrg(seeded.org.id, seeded.emails);
  await prisma.$disconnect();
});

test('all five paid reports count the renamed tenant’s own finished stage', async ({ page }) => {
  await signInAndSettle(page, seeded.adminEmail, PASSWORD, '/admin');

  // ── free-core surfaces (no premium gate) ─────────────────────────────────
  const overviewRes = await page.request.get('/api/admin/analytics');
  expect(overviewRes.ok()).toBeTruthy();
  const overview = await overviewRes.json();
  // The tenant's own stage is named back, so the screen can label the number.
  expect(overview.finishedLabel).toBe('Custom F');
  expect(overview.finishedLabelIsCustom).toBe(true);
  // The seeded relation sits on STAGE_F, and its mentor's outcome count sees it.
  const mine = (overview.mentorWorkload as { id: string; hired: number }[]).find((m) => m.id === mentorId);
  expect(mine?.hired).toBe(1);

  const mentorRes = await page.request.get('/api/mentor/analytics');
  expect(mentorRes.ok()).toBeTruthy();
  const mentorData = await mentorRes.json();
  expect(mentorData.finishedLabel).toBe('Custom F');
  expect(mentorData.hired).toBeGreaterThan(0);
  expect(mentorData.conversionToHired).toBeGreaterThan(0);

  // ── premium surfaces ─────────────────────────────────────────────────────
  const enable = await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } });
  expect(enable.ok()).toBeTruthy();
  try {
    const cohortsRes = await page.request.get('/api/admin/analytics/cohorts');
    expect(cohortsRes.ok()).toBeTruthy();
    const cohorts = await cohortsRes.json();
    expect(cohorts.finishedLabel).toBe('Custom F');
    const row = (cohorts.cohorts as { id: string; hired: number; conversionToHired: number; avgDaysToHired: number | null }[])
      .find((c) => c.id === cohortId);
    expect(row?.hired).toBe(1);
    expect(row?.conversionToHired).toBe(100);
    // Time-to-hire is measured to STAGE_F, so the recorded transition counts;
    // against a hardcoded HIRED_660 the `statusChanges` filter matched nothing
    // and this stayed null.
    expect(row?.avgDaysToHired).not.toBeNull();

    const sourcesRes = await page.request.get('/api/admin/analytics/sources');
    expect(sourcesRes.ok()).toBeTruthy();
    const sources = await sourcesRes.json();
    const sourceRow = (sources.sources as { id: string; hired: number; conversionToHired: number }[])
      .find((s) => s.id === sourceId);
    expect(sourceRow?.hired).toBe(1);
    expect(sourceRow?.conversionToHired).toBe(100);

    const benchRes = await page.request.get('/api/admin/analytics/benchmark');
    expect(benchRes.ok()).toBeTruthy();
    const bench = await benchRes.json();
    // The k-anonymity floor still applies to the POOL, not to your own row.
    expect(bench.platform.minRelations).toBe(5);
    expect(bench.you?.hired).toBe(1);
    expect(bench.you?.conversion).toBe(100);
    expect(bench.finishedLabel).toBe('Custom F');
    // Aggregates only: no other program is identified anywhere in the payload.
    expect(JSON.stringify(bench)).not.toContain(seeded.org.id);
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
  }
});

test('the renamed tenant is not the default one — the assertions above are not vacuous', async () => {
  const stages = await prisma.pipelineStage.findMany({ where: { orgId: seeded.org.id } });
  expect(stages.some((s) => s.key === 'HIRED_660' || s.key === 'EMPLOYED_700')).toBe(false);
});

test('an org on the built-in catalogue resolves exactly the sets the routes hardcoded', async () => {
  // The hard regression bar: `resolvePipelineStages` falls back to
  // `defaultPipelineStages()` for an org with no PipelineStage rows, so this is
  // the same value every default-catalogue tenant gets from `outcomeStageKeys`.
  const outcome = outcomeStageKeysFrom(defaultPipelineStages());
  expect(outcome.finished).toEqual(['HIRED_660', 'EMPLOYED_700']);
  expect(outcome.offPath).toEqual(['INTERNSHIP_DROPPED_460', 'INTERNSHIP_FOUND_ELSEWHERE_800']);
  expect(outcome.first).toBe('APPLICATION_100');
  // Never renamed, so every screen keeps its own translated wording.
  expect(outcome.finishedLabelIsCustom).toBe(false);
});

test('a renamed six-stage set finishes on its own last stage', async () => {
  const outcome = outcomeStageKeysFrom(
    ['STAGE_A', 'STAGE_B', 'STAGE_C', 'STAGE_D', 'STAGE_E', 'STAGE_F'].map((key, i) => ({
      key,
      label: `Custom ${key.slice(-1)}`,
      order: i,
      isTerminal: i === 5,
      isOffPath: false,
      color: null,
    })),
  );
  expect(outcome.finished).toEqual(['STAGE_F']);
  expect(outcome.first).toBe('STAGE_A');
  expect(outcome.finishedLabel).toBe('Custom F');
  expect(outcome.finishedLabelIsCustom).toBe(true);
});
