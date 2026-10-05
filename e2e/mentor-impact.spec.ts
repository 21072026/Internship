import { test, expect } from '@playwright/test';
import {
  prisma,
  seedUser,
  uniqueEmail,
  cleanupByEmail,
  seedCustomPipelineOrg,
  cleanupCustomPipelineOrg,
} from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * The mentor's private "your impact" card on /mentor (light gamification).
 *
 * What is pinned here, end to end against a real database:
 *   - the four counts are the signed-in mentor's OWN people — another mentor's
 *     hired mentee in the same tenant moves nothing;
 *   - "reached" reads stage history: a mentee who was hired and then moved on
 *     still counts;
 *   - a renamed pipeline counts its own finished stage, and names it;
 *   - zero relations → no card at all (honesty rule);
 *   - a MARKETING MENTOR never sees it — the mentor layout sends them to /sales;
 *   - the progress bars are real progressbars and the card reads in dark mode.
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'MentorImpact123!';
const STAMP = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const mentorEmail = uniqueEmail(`impact-mentor-${STAMP}`);
const otherMentorEmail = uniqueEmail(`impact-other-${STAMP}`);
const emptyMentorEmail = uniqueEmail(`impact-empty-${STAMP}`);
const handoverFromEmail = uniqueEmail(`impact-from-${STAMP}`);
const handoverToEmail = uniqueEmail(`impact-to-${STAMP}`);
const handedOverEmail = uniqueEmail(`impact-handed-${STAMP}`);
const menteeEmails = ['a', 'b', 'c', 'x'].map((n) => uniqueEmail(`impact-mentee-${n}-${STAMP}`));
const marketingRepEmail = uniqueEmail(`impact-rep-${STAMP}`);
const marketingLeadEmail = uniqueEmail(`impact-lead-${STAMP}`);
const allEmails = [
  mentorEmail,
  otherMentorEmail,
  emptyMentorEmail,
  ...menteeEmails,
  marketingRepEmail,
  marketingLeadEmail,
  handoverFromEmail,
  handoverToEmail,
  handedOverEmail,
];

let custom: Awaited<ReturnType<typeof seedCustomPipelineOrg>> | null = null;
let marketingOrgId = '';

test.beforeAll(async () => {
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', `Impact Mentor ${STAMP}`);
  const other = await seedUser(otherMentorEmail, PASSWORD, 'MENTOR', `Other Mentor ${STAMP}`);
  await seedUser(emptyMentorEmail, PASSWORD, 'MENTOR', `Empty Mentor ${STAMP}`);
  const [a, b, c, x] = await Promise.all(
    menteeEmails.map((e, i) => seedUser(e, PASSWORD, 'MENTEE', `Impact Mentee ${i} ${STAMP}`)),
  );

  // A: just started, active.
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: a.id, pipelineStatus: 'APPLICATION_100' },
  });
  // B: in an internship now, active, walked there through the history.
  const relB = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: b.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  await prisma.statusChange.createMany({
    data: [
      { relationId: relB.id, fromStatus: 'APPLICATION_100', toStatus: 'INTERNSHIP_STARTING_300' },
      { relationId: relB.id, fromStatus: 'INTERNSHIP_STARTING_300', toStatus: 'INTERNSHIP_IN_PROGRESS_450' },
    ],
  });
  // C: was hired, then moved on to an off-path stage; relation completed.
  // The current stage is no outcome — only the history says they got there.
  const relC = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: c.id,
      status: 'COMPLETED',
      pipelineStatus: 'INTERNSHIP_FOUND_ELSEWHERE_800',
    },
  });
  await prisma.statusChange.createMany({
    data: [
      { relationId: relC.id, fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660' },
      { relationId: relC.id, fromStatus: 'HIRED_660', toStatus: 'INTERNSHIP_FOUND_ELSEWHERE_800' },
    ],
  });
  // X: ANOTHER mentor's hired mentee — must not appear in our mentor's counts.
  await prisma.mentorshipRelation.create({
    data: { mentorId: other.id, menteeId: x.id, pipelineStatus: 'HIRED_660' },
  });

  // A handover (docs/mentor-transfer.md): the outgoing mentor walked the person
  // to HIRED_660, then the relation was ended and continued by the incoming
  // mentor on the same stage (`previousRelationId`), with no move of its own.
  const from = await seedUser(handoverFromEmail, PASSWORD, 'MENTOR', `Handover From ${STAMP}`);
  const to = await seedUser(handoverToEmail, PASSWORD, 'MENTOR', `Handover To ${STAMP}`);
  const handed = await seedUser(handedOverEmail, PASSWORD, 'MENTEE', `Handed Over ${STAMP}`);
  const before = await prisma.mentorshipRelation.create({
    data: { mentorId: from.id, menteeId: handed.id, status: 'COMPLETED', pipelineStatus: 'HIRED_660' },
  });
  await prisma.statusChange.create({
    data: { relationId: before.id, fromStatus: 'INTERNSHIP_COMPLETED_490', toStatus: 'HIRED_660' },
  });
  await prisma.mentorshipRelation.create({
    data: { mentorId: to.id, menteeId: handed.id, pipelineStatus: 'HIRED_660', previousRelationId: before.id },
  });

  // A renamed pipeline (STAGE_A…STAGE_F, one relation on STAGE_F).
  custom = await seedCustomPipelineOrg('impact-custom', PASSWORD);

  // A MARKETING tenant with a MENTOR (a sales rep) who owns one record.
  const org = await prisma.organization.create({
    data: { name: `Impact Marketing ${STAMP}`, slug: `impact-mkt-${STAMP}`, vertical: 'MARKETING' },
  });
  marketingOrgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING')!;
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  const rep = await seedUser(marketingRepEmail, PASSWORD, 'MENTOR', `Impact Rep ${STAMP}`, org.id);
  const lead = await seedUser(marketingLeadEmail, PASSWORD, 'MENTEE', `Impact Lead ${STAMP}`, org.id);
  await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: rep.id, menteeId: lead.id, pipelineStatus: preset.stages[0].key },
  });
});

test.afterAll(async () => {
  for (const email of allEmails) await cleanupByEmail(email).catch(() => {});
  if (custom) await cleanupCustomPipelineOrg(custom.org.id, custom.emails);
  if (marketingOrgId) {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: marketingOrgId } });
    await prisma.pipelineStage.deleteMany({ where: { orgId: marketingOrgId } });
    await prisma.organization.delete({ where: { id: marketingOrgId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

test('a mentor sees their own impact: people, active, reached internship, reached hired (from history)', async ({ page }) => {
  await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
  await gotoSettled(page, '/mentor');

  const card = page.getByTestId('mentor-impact-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Your impact' })).toBeVisible();
  await expect(card).toContainText('Only you can see this');
  // A named region, so a screen reader can jump to it.
  await expect(page.getByRole('region', { name: 'Your impact' })).toBeVisible();

  await expect(card.getByTestId('mentor-impact-mentored-value')).toHaveText('3');
  await expect(card.getByTestId('mentor-impact-active-value')).toHaveText('2');
  // B (in progress) and C (hired, then moved on) — not A, not the other mentor's X.
  await expect(card.getByTestId('mentor-impact-internship-value')).toHaveText('2 of 3');
  await expect(card.getByTestId('mentor-impact-outcome-value')).toHaveText('1 of 3');
  await expect(card.getByTestId('mentor-impact-outcome')).toContainText('Hired');

  const bars = card.getByRole('progressbar');
  await expect(bars).toHaveCount(2);
  const outcomeBar = card.getByRole('progressbar', { name: 'Hired' });
  await expect(outcomeBar).toHaveAttribute('aria-valuenow', '1');
  await expect(outcomeBar).toHaveAttribute('aria-valuemax', '3');
  await expect(card.getByRole('progressbar', { name: 'Reached an internship or beyond' })).toHaveAttribute(
    'aria-valuenow',
    '2',
  );

  // Nothing that ranks or compares: no rank position, percentile, percentage
  // or average (the card's own "never ranked" sentence is allowed).
  await expect(card).not.toContainText(/percentile|top \d|\d+\s*%|average|#\d/i);
});

test('the card reads in dark mode and fits a phone width', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'theme', value: 'dark', url: baseURL ?? 'http://localhost:3000' }]);
  await page.setViewportSize({ width: 375, height: 800 });
  await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
  await gotoSettled(page, '/mentor');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);

  const card = page.getByTestId('mentor-impact-card');
  await expect(card).toBeVisible();
  const lum = (rgb: string) => {
    const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const bg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
  const fg = await card.getByTestId('mentor-impact-mentored-value').evaluate((el) => getComputedStyle(el).color);
  const label = await card.getByTestId('mentor-impact-outcome').evaluate((el) => getComputedStyle(el.querySelector('span')!).color);
  expect(lum(bg)).toBeLessThan(60);
  expect(lum(fg)).toBeGreaterThan(180);
  expect(lum(label)).toBeGreaterThan(150);

  // No horizontal overflow at phone width.
  const box = await card.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
});

test('a mentor with no relations sees no card at all', async ({ page }) => {
  await signInAndSettle(page, emptyMentorEmail, PASSWORD, '/mentor');
  await gotoSettled(page, '/mentor');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('mentor-impact-card')).toHaveCount(0);
});

test('a handover is not a visit: the incoming mentor is not credited with an inherited outcome', async ({ page }) => {
  await signInAndSettle(page, handoverToEmail, PASSWORD, '/mentor');
  await gotoSettled(page, '/mentor');
  const card = page.getByTestId('mentor-impact-card');
  await expect(card.getByTestId('mentor-impact-mentored-value')).toHaveText('1');
  await expect(card.getByTestId('mentor-impact-active-value')).toHaveText('1');
  await expect(card.getByTestId('mentor-impact-outcome-value')).toHaveText('0 of 1');
  await expect(card.getByTestId('mentor-impact-internship-value')).toHaveText('0 of 1');
  await expect(card).toContainText('before being handed over to you are not counted');
});

test('…while the outgoing mentor keeps the outcome they reached', async ({ page }) => {
  await signInAndSettle(page, handoverFromEmail, PASSWORD, '/mentor');
  await gotoSettled(page, '/mentor');
  const card = page.getByTestId('mentor-impact-card');
  await expect(card.getByTestId('mentor-impact-mentored-value')).toHaveText('1');
  await expect(card.getByTestId('mentor-impact-active-value')).toHaveText('0');
  await expect(card.getByTestId('mentor-impact-outcome-value')).toHaveText('1 of 1');
  await expect(card.getByTestId('mentor-impact-internship-value')).toHaveText('1 of 1');
});

test('a renamed pipeline counts — and names — its own finished stage', async ({ page }) => {
  const mentor = await prisma.mentorshipRelation.findUniqueOrThrow({
    where: { id: custom!.relationId },
    select: { mentor: { select: { email: true } } },
  });
  await signInAndSettle(page, mentor.mentor.email, PASSWORD, '/mentor');
  await gotoSettled(page, '/mentor');

  const card = page.getByTestId('mentor-impact-card');
  await expect(card.getByTestId('mentor-impact-mentored-value')).toHaveText('1');
  await expect(card.getByTestId('mentor-impact-outcome')).toContainText('Reached “Custom F”');
  await expect(card.getByTestId('mentor-impact-outcome-value')).toHaveText('1 of 1');
  // STAGE_A…STAGE_F has no internship stage: the row is hidden, not guessed.
  await expect(card.getByTestId('mentor-impact-internship')).toHaveCount(0);
});

test('a MARKETING mentor (sales rep) is sent to /sales and never sees the card', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, marketingRepEmail, PASSWORD, '/sales');
  await page.goto('/mentor');
  await page.waitForURL((u) => u.pathname.startsWith('/sales'));
  await expect(page.getByTestId('mentor-impact-card')).toHaveCount(0);
});
