import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// /admin/health — the org-wide at-risk queue (#1902). Its own org, so the
// ranking is exactly the pairs seeded here:
//   red   — a deactivated mentor, never in touch, deadline passed → AT_RISK,
//           and its one next action is "reassign";
//   amber — in touch, but the deadline passed and nothing moved → WATCH;
//   quiet — brand new, in touch, a goal open → nothing to do, not listed;
//   dormant — messaged at first contact four months ago, never replied;
//   done  — a COMPLETED relation;
//   paused — never in touch, deadline passed, but PAUSED (status stays ACTIVE):
//           excluded, not flagged (#1894).
// The last four are the footnote counts.

const PW = 'AdminHealth123!';
const DAY = 24 * 60 * 60 * 1000;

test.describe('admin health monitor', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('ah-admin');
  const mentor = uniqueEmail('ah-mentor');
  const goneMentor = uniqueEmail('ah-gone-mentor');
  const mentees = ['red', 'amber', 'quiet', 'dormant', 'done', 'paused'].map((k) => ({ k, email: uniqueEmail(`ah-${k}`) }));
  let orgId = '';
  const rel: Record<string, string> = {};

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `AH Org ${stamp}`, slug: `ah-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `AH Admin ${stamp}`, orgId);
    const m = await seedUser(mentor, PW, 'MENTOR', `AH Mentor ${stamp}`, orgId);
    const gone = await seedUser(goneMentor, PW, 'MENTOR', `AH Gone Mentor ${stamp}`, orgId);
    await prisma.user.update({ where: { id: gone.id }, data: { isActive: false } });
    const ids: Record<string, string> = {};
    for (const { k, email } of mentees) ids[k] = (await seedUser(email, PW, 'MENTEE', `AH ${k} ${stamp}`, orgId)).id;

    const create = (k: string, data: Record<string, unknown>) =>
      prisma.mentorshipRelation.create({ data: { orgId, mentorId: m.id, menteeId: ids[k], ...data } }).then((r) => (rel[k] = r.id));

    await create('red', { mentorId: gone.id, pipelineStatus: 'INTERVIEW_PENDING_250', startDate: new Date(Date.now() - 200 * DAY), stageDeadline: new Date(Date.now() - 5 * DAY) });
    await create('amber', { pipelineStatus: 'INTERVIEW_PENDING_250', startDate: new Date(Date.now() - 200 * DAY), stageDeadline: new Date(Date.now() - 5 * DAY) });
    await prisma.interactionLog.create({ data: { relationId: rel.amber, date: new Date(Date.now() - 2 * DAY), notes: 'Check-in', type: 'Call' } });
    await create('quiet', { pipelineStatus: 'INTERVIEW_PENDING_250', startDate: new Date(Date.now() - 5 * DAY) });
    await prisma.interactionLog.create({ data: { relationId: rel.quiet, date: new Date(Date.now() - DAY), notes: 'Kick-off', type: 'Meeting' } });
    await prisma.goal.create({ data: { relationId: rel.quiet, title: 'First CV draft' } });
    await create('dormant', { pipelineStatus: 'APPLICATION_100', startDate: new Date(Date.now() - 150 * DAY) });
    await prisma.interactionLog.create({ data: { relationId: rel.dormant, date: new Date(Date.now() - 120 * DAY), notes: 'Welcome email', type: 'Email' } });
    await create('done', { status: 'COMPLETED', completedAt: new Date() });
    await create('paused', { pipelineStatus: 'INTERVIEW_PENDING_250', startDate: new Date(Date.now() - 200 * DAY), stageDeadline: new Date(Date.now() - 5 * DAY), lifecycleState: 'PAUSED', pausedAt: new Date() });
  });

  test.afterAll(async () => {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, goneMentor, ...mentees.map((x) => x.email)]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('worst first, one next action per row, and the exclusions as a footnote', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');

    const api = await (await page.request.get('/api/admin/health')).json();
    expect(api.rows.map((r: { relationId: string }) => r.relationId)).toEqual([rel.red, rel.amber]);
    expect(api.rows[0]).toMatchObject({ band: 'AT_RISK', nextAction: { kind: 'reassign', href: `/admin/mentorship?transfer=${rel.red}` } });
    expect(api.rows[1]).toMatchObject({ band: 'WATCH', nextAction: { kind: 'set_deadline' } });
    expect(api.rows[1].reasons).toEqual(expect.arrayContaining(['overdue', 'stage_stalled']));
    expect(api.counts).toMatchObject({ AT_RISK: 1, WATCH: 1, HEALTHY: 1 });
    expect(api.excluded).toEqual({ dormant: 1, paused: 1, notActive: 1, quiet: 1 });

    await page.goto('/admin/health');
    const rows = page.getByTestId('health-table').locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-testid', `health-row-${rel.red}`);
    await expect(rows.nth(1)).toHaveAttribute('data-testid', `health-row-${rel.amber}`);
    for (const id of [rel.red, rel.amber]) await expect(page.getByTestId(`health-row-${id}`).locator('[data-action]')).toHaveCount(1);
    await expect(page.getByTestId(`health-action-${rel.amber}`)).toHaveAttribute('href', `/admin/candidates/${(await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.amber } })).menteeId}#relation-stage`);
    await expect(page.getByTestId('health-foot-dormant')).toContainText('1');
    await expect(page.getByTestId('health-foot-not-active')).toContainText('1');
    await expect(page.getByTestId('health-foot-paused')).toContainText('1');
    await expect(page.getByTestId('health-foot-quiet')).toContainText('1');

    // The band filter, by its own testid — never the AdminNav search box.
    await page.getByTestId('health-filter-band').selectOption('WATCH');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toHaveAttribute('data-testid', `health-row-${rel.amber}`);

    // A deep link preselects the band — the scorecard's at-risk action (#1908).
    await page.goto('/admin/health?band=WATCH');
    await expect(page.getByTestId('health-filter-band')).toHaveValue('WATCH');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toHaveAttribute('data-testid', `health-row-${rel.amber}`);

    // The page says what the score is and links the published rules.
    await page.getByTestId('health-how').locator('summary').click();
    await expect(page.getByTestId('health-rules-link')).toHaveAttribute('href', /docs\/relationship-health\.md$/);

    // "Reassign" lands on the change-mentor dialog for that pairing.
    await page.getByTestId('health-filter-band').selectOption('AT_RISK');
    await page.getByTestId(`health-action-${rel.red}`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/mentorship\\?transfer=${rel.red}`));
    await expect(page.getByRole('dialog')).toContainText(`AH red ${stamp}`);
  });

  test('the API is ADMIN-only, checked in the handler', async ({ page }) => {
    await signInAndSettle(page, mentor, PW, '/mentor');
    expect((await page.request.get('/api/admin/health')).status()).toBe(403);
    await signInAsFreshUser(page, mentees[0].email, PW, '/portal');
    expect((await page.request.get('/api/admin/health')).status()).toBe(403);
    const company = uniqueEmail('ah-company');
    try {
      await seedUser(company, PW, 'COMPANY', `AH Company ${stamp}`, orgId);
      await signInAsFreshUser(page, company, PW, '/company');
      expect((await page.request.get('/api/admin/health')).status()).toBe(403);
    } finally {
      await cleanupByEmail(company);
    }
  });
});
