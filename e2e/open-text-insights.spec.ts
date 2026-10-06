import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';
import { prepareOpenText } from '../src/lib/ai/openTextRules';
import { openTextInputHash } from '../src/lib/ai/summarizeOpenText';
import { INSIGHT_PURPOSE } from '../src/lib/insights/openTextSources';

// Open-text insights (#2046). Each test runs in an org of its own, so the rows
// in range are exactly the ones seeded here. CI has no provider key, which is
// what makes "nothing was sent" provable: a real attempt ends at a typed reason
// and never writes an AiUsage row.

const PW = 'Insights123!';
const DAY = 24 * 60 * 60 * 1000;

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedOrg(prefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const org = await prisma.organization.create({ data: { name: `${prefix} ${stamp}`, slug: `${prefix.toLowerCase()}-${stamp}` } });
  const emails = { admin: uniqueEmail(`${prefix}-admin`), mentor: uniqueEmail(`${prefix}-mentor`), mentee: uniqueEmail(`${prefix}-mentee`) };
  await seedUser(emails.admin, PW, 'ADMIN', `${prefix} Admin`, org.id);
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'Deniz Kaya', org.id);
  const mentee = await seedUser(emails.mentee, PW, 'MENTEE', 'Elif Demir', org.id);
  const cleanup = async () => {
    await prisma.aiArtifact.deleteMany({ where: { orgId: org.id } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  };
  return { org, emails, mentor, mentee, cleanup };
}

test('evaluation themes: refused below the floor, nothing sent; a stored summary opens its rows', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const { org, emails, mentor, mentee, cleanup } = await seedOrg('Insight');
  try {
    const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', orgId: org.id } });
    const now = Date.now();
    const comment = (text: string, daysAgo: number) =>
      prisma.evaluation.create({ data: { relationId: rel.id, authorId: mentor.id, comment: text, createdAt: new Date(now - daysAgo * DAY), submittedAt: new Date(now - daysAgo * DAY) } });
    await comment('Elif struggles with Git rebases.', 3);
    await comment('Great progress on the API task.', 2);

    await signInAndSettle(page, emails.admin, PW, '/admin');
    const usageBefore = await prisma.aiUsage.count();
    // Two rows: the refusal is all there is — on GET and on POST alike.
    const peek = await (await page.request.get('/api/admin/insights/evaluations')).json();
    expect(peek).toMatchObject({ available: 2, floor: 3, summary: null, reason: 'below_floor', caveats: [{ code: 'below_floor', floor: 3, available: 2 }] });
    const refused = await (await page.request.post('/api/admin/insights/evaluations', { data: {} })).json();
    expect(refused).toMatchObject({ summary: null, reason: 'below_floor', sources: [] });
    expect(await prisma.aiUsage.count()).toBe(usageBefore);
    await page.goto('/admin/insights');
    await expect(page.getByTestId('insights-below-floor')).toContainText('2 of at least 3');

    // A third row: now it is asked — and, with no provider here, says why,
    // while the numbers are all still there.
    await comment('Onboarding docs were outdated, lost two days.', 1);
    const asked = await (await page.request.post('/api/admin/insights/evaluations', { data: {} })).json();
    expect(asked.available).toBe(3);
    expect(asked.summary).toBeNull();
    expect(['not_configured', 'quota_exceeded']).toContain(asked.reason);
    expect(await prisma.aiUsage.count()).toBe(usageBefore);

    // A stored summary for exactly these rows — as the engine would have
    // written it: same masking (names never leave), same order (newest first).
    const evals = await prisma.evaluation.findMany({ where: { relationId: rel.id }, orderBy: { createdAt: 'desc' }, select: { id: true, comment: true } });
    const { prepared } = prepareOpenText(evals.map((e) => ({ id: e.id, text: e.comment! })), { names: ['Elif Demir', 'Deniz Kaya'] });
    expect(prepared.find((p) => p.text.includes('Git'))!.text).toBe('[name] struggles with Git rebases.');
    const gitId = evals.find((e) => e.comment!.includes('Git'))!.id;
    const docsId = evals.find((e) => e.comment!.includes('Onboarding'))!.id;
    await prisma.aiArtifact.create({
      data: {
        orgId: org.id,
        taskId: 'evaluation_insights',
        createdById: mentor.id,
        inputHash: openTextInputHash({ purpose: INSIGHT_PURPOSE.evaluations, locale: 'en' }, prepared),
        content: JSON.stringify({
          themes: [{ label: 'Tooling friction', count: 2, exampleIds: [gitId, docsId], sentiment: 'negative' }],
          overall: { positive: 1, neutral: 0, negative: 2, unclear: 0 },
          notableQuotes: [{ id: docsId, text: 'lost two days' }],
          caveats: [{ code: 'names_masked' }],
          sent: 3,
        }),
      },
    });
    // GET answers from it — no call, no quota — and so does the page on load.
    const stored = await (await page.request.get('/api/admin/insights/evaluations')).json();
    expect(stored).toMatchObject({ cached: true, summary: { themes: [{ label: 'Tooling friction', count: 2, people: 1 }] } });
    expect(stored.sources.map((s: { id: string }) => s.id).sort()).toEqual([gitId, docsId].sort());
    expect(await prisma.aiUsage.count()).toBe(usageBefore);
    await page.goto('/admin/insights');
    const theme = page.getByTestId('insights-theme').first();
    await expect(theme).toContainText('Tooling friction');
    await expect(theme).toContainText('mostly negative');
    // The theme opens the rows it was built from, with a way to the record.
    await theme.getByTestId('insights-theme-toggle').click();
    const opened = theme.getByTestId('insights-theme-rows');
    await expect(opened).toContainText('Elif struggles with Git rebases.');
    await expect(opened).toContainText('Onboarding docs were outdated');
    await expect(opened.getByRole('link').first()).toHaveAttribute('href', `/admin/candidates/${mentee.id}`);
    await expect(page.getByTestId('insights-overall')).toContainText('mostly negative: 2');
    await expect(page.getByTestId('insights-caveats')).toContainText('Names were masked');

    // The stored summary may quote anyone in it: erasing one person wipes the
    // org's copies (a cache — the next request regenerates without them).
    const erased = await page.request.post(`/api/admin/users/${mentee.id}/erase`, {
      data: { mode: 'anonymize', confirmName: 'Elif Demir', adminPassword: PW },
    });
    expect(erased.ok()).toBe(true);
    expect(await prisma.aiArtifact.count({ where: { orgId: org.id, taskId: 'evaluation_insights' } })).toBe(0);
  } finally {
    await cleanup();
  }
});

test('weekly digest: who has not handed in last week renders with AI off, and a lone blocker is not summarised', async ({ page }) => {
  test.slow();
  const { org, emails, mentor, mentee, cleanup } = await seedOrg('Digest');
  try {
    const rel = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', orgId: org.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450', startDate: new Date(Date.now() - 35 * DAY) },
    });
    // A report two weeks back with a blocker; nothing for last week.
    const thisMonday = new Date();
    thisMonday.setUTCHours(0, 0, 0, 0);
    thisMonday.setUTCDate(thisMonday.getUTCDate() - ((thisMonday.getUTCDay() + 6) % 7));
    const twoWeeksAgo = new Date(thisMonday.getTime() - 14 * DAY);
    await prisma.weeklyReport.create({
      data: { orgId: org.id, relationId: rel.id, weekStart: twoWeeksAgo, summary: 'Set up the repo.', blockers: 'VPN access still missing.', status: 'SUBMITTED', submittedAt: new Date(twoWeeksAgo.getTime() + 4 * DAY) },
    });

    await signInAndSettle(page, emails.admin, PW, '/admin');
    const body = await (await page.request.get('/api/admin/insights/weekly-reports')).json();
    expect(body).toMatchObject({ available: 1, reason: 'below_floor', summary: null });
    expect(body.figures.weeks).toEqual([{ weekStart: twoWeeksAgo.toISOString(), submitted: 1, withBlockers: 1 }]);
    expect(body.figures.lastWeekStart).toBe(new Date(thisMonday.getTime() - 7 * DAY).toISOString());
    expect(body.figures.notSubmitted).toEqual([expect.objectContaining({ relationId: rel.id, menteeName: 'Elif Demir', mentorName: 'Deniz Kaya' })]);

    await page.goto('/admin/insights');
    await page.getByTestId('insights-tab-weekly-reports').click();
    await expect(page.getByTestId('insights-not-submitted')).toContainText('Elif Demir');
    await expect(page.getByTestId('insights-below-floor')).toBeVisible();
    // A non-admin is refused at the route.
    await signInAsFreshUser(page, emails.mentor, PW, '/mentor');
    expect((await page.request.get('/api/admin/insights/weekly-reports')).status()).toBe(403);
  } finally {
    await cleanup();
  }
});
