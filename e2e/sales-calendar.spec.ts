import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, signInViaApi, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
// Static import, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { writeSetting } from '../src/lib/settingsWrite';

// The sales rep's calendar (#3778): /sales/calendar, GET /api/sales/calendar,
// the "New meeting" / "Plan meeting" dialog on POST /api/meetings, and the
// follow-ups in the ICS subscription feed.

test.describe.configure({ mode: 'serial' });

const PW = 'SalesCal123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const DAY = 24 * 60 * 60 * 1000;

const orgIds: string[] = [];
const emails: string[] = [];
const ids: Record<string, string> = {};
const mail: Record<string, string> = {};

/** The browser's (and this process's) local day, as the calendar keys it. */
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = new Date();
const todayKey = localDay(today);
const tomorrowKey = localDay(new Date(today.getTime() + DAY));
/** A follow-up / trial day is stored at UTC midnight of that calendar day. */
const utcMidnight = (key: string) => new Date(`${key}T00:00:00.000Z`);

async function marketingOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Sales Cal ${label} ${STAMP}`, slug: `sales-cal-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId: org.id,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  return org.id;
}

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId: string) {
  const email = uniqueEmail(`sales-cal-${label}-${STAMP}`);
  emails.push(email);
  const user = await seedUser(email, PW, role, `Cal ${label} ${STAMP}`, orgId);
  ids[label] = user.id;
  mail[label] = email;
  return user.id;
}

async function lead(label: string, ownerId: string, orgId: string, data: Record<string, unknown> = {}) {
  const menteeId = await person(`lead-${label}`, 'MENTEE', orgId);
  const rel = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ownerId, menteeId, pipelineStatus: 'LEAD_QUALIFIED', ...data },
  });
  ids[`rel-${label}`] = rel.id;
  return rel.id;
}

async function repJar(
  playwright: { request: { newContext: (o: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }) => Promise<APIRequestContext> } },
  baseURL: string | undefined,
  label: string,
) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: asHost(MARKETING_HOST) });
  const res = await signInViaApi(ctx, mail[label], PW, { host: MARKETING_HOST, headers: freshIp(`sales-cal-${label}`) });
  expect(res.error, `sign-in ${label}`).toBeNull();
  return ctx;
}

test.beforeAll(async () => {
  const orgA = await marketingOrg('a');
  const internship = await prisma.organization.create({
    data: { name: `Sales Cal INT ${STAMP}`, slug: `sales-cal-int-${STAMP}`, vertical: 'INTERNSHIP' },
  });
  orgIds.push(internship.id);

  await person('rep', 'MENTOR', orgA);
  await person('colleague', 'MENTOR', orgA);
  await person('admin', 'ADMIN', orgA);
  ids.orgA = orgA;
  await person('intMentor', 'MENTOR', internship.id);

  // Today: a meeting with lead A, lead B's follow-up, lead C's trial end.
  await lead('meet', ids.rep, orgA);
  await lead('follow', ids.rep, orgA, { nextActionAt: utcMidnight(todayKey), nextActionNote: 'Send the price sheet' });
  await lead('trial', ids.rep, orgA, { pipelineStatus: 'TRIAL_ACTIVE', trialStartedAt: new Date(Date.now() - 10 * DAY), trialEndsAt: utcMidnight(todayKey) });
  // Overdue: yesterday's follow-up, never done.
  await lead('overdue', ids.rep, orgA, { nextActionAt: utcMidnight(localDay(new Date(today.getTime() - DAY))), nextActionNote: 'Chase the signature' });
  // An open to-do of the rep's own.
  const todo = await prisma.projectTask.create({ data: { title: `Prepare the demo deck ${STAMP}`, assigneeId: ids.rep, createdById: ids.rep } });
  ids.todo = todo.id;
  // A colleague's record with the same kinds of items — must never show.
  await lead('colleague', ids.colleague, orgA, { nextActionAt: utcMidnight(todayKey), nextActionNote: 'Colleague step' });

  const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0);
  const meeting = await prisma.meeting.create({
    data: { relationId: ids['rel-meet'], title: `Discovery call ${STAMP}`, scheduledAt: at, durationMinutes: 30, status: 'SCHEDULED', createdById: ids.rep, rsvpToken: `rsvp-${STAMP}-a` },
  });
  ids.meeting = meeting.id;
  ids.colleagueMeeting = (await prisma.meeting.create({
    data: { relationId: ids['rel-colleague'], title: `Colleague call ${STAMP}`, scheduledAt: at, status: 'SCHEDULED', createdById: ids.colleague, rsvpToken: `rsvp-${STAMP}-b` },
  })).id;
});

test.afterAll(async () => {
  const relIds = Object.entries(ids).filter(([k]) => k.startsWith('rel-')).map(([, v]) => v);
  await prisma.meeting.deleteMany({ where: { relationId: { in: relIds } } }).catch(() => {});
  await prisma.projectTask.deleteMany({ where: { id: ids.todo } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  for (const email of emails) await cleanupByEmail(email);
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

test("a rep cannot put a meeting on a colleague's lead", { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const rep = await repJar(playwright, baseURL, 'rep');
  const res = await rep.post('/api/meetings', {
    data: { relationIds: [ids['rel-colleague']], title: 'Not mine', scheduledAt: new Date(Date.now() + 2 * DAY).toISOString() },
  });
  expect(res.status()).toBe(404);
  expect((await res.json()).code).toBe('relation_not_found');
  expect(await prisma.meeting.count({ where: { relationId: ids['rel-colleague'], title: 'Not mine' } })).toBe(0);
  // …and the colleague's items never reach the rep's calendar feed.
  const cal = await rep.get(`/api/sales/calendar?from=${todayKey}&to=${todayKey}`);
  expect(cal.status()).toBe(200);
  const body = JSON.stringify(await cal.json());
  expect(body).not.toContain(ids['rel-colleague']);
  expect(body).not.toContain(`Colleague call ${STAMP}`);
  await rep.dispose();
});

test('the rep sees their meeting, follow-up and trial end on the day, and an item opens the lead', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mail.rep, PW, '/sales');
  await page.getByTestId('sales-nav').getByRole('link', { name: 'Calendar', exact: true }).click();
  await page.waitForURL('**/sales/calendar');
  await gotoSettled(page, '/sales/calendar');

  await expect(page.getByTestId('calendar-view-week')).toHaveAttribute('aria-pressed', 'true');
  const day = page.getByTestId(`calendar-day-${todayKey}`);
  await expect(day.getByTestId(`calendar-event-meeting-${ids.meeting}`)).toBeVisible({ timeout: 20_000 });
  await expect(day.getByTestId(`calendar-event-followup-${ids['rel-follow']}`)).toBeVisible();
  await expect(day.getByTestId(`calendar-event-trial-${ids['rel-trial']}`)).toBeVisible();
  await expect(page.getByText(`Colleague call ${STAMP}`)).toHaveCount(0);
  await expect(page.getByTestId('calendar-legend')).toContainText('Follow-up');
  await expect(page.getByTestId('calendar-legend')).toContainText('Trial ends');
  // The subscription card is on the page.
  await expect(page.getByTestId('ics-feed-card')).toBeVisible();

  await day.getByTestId(`calendar-event-followup-${ids['rel-follow']}`).getByRole('link').click();
  await page.waitForURL(`**/sales/leads/${ids['rel-follow']}`);
  await expect(page.getByTestId('sales-lead-name')).toHaveText(`Cal lead-follow ${STAMP}`);
});

test('"New meeting" schedules with one of the rep\'s leads and the meeting lands on the calendar; the lead page plans the same', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mail.rep, PW, '/sales');
  await gotoSettled(page, '/sales/calendar');

  await page.getByTestId('sales-calendar-new-meeting').click();
  const dialog = page.getByTestId('plan-meeting-dialog');
  await expect(dialog).toBeVisible();
  const leadSelect = dialog.getByTestId('plan-meeting-lead');
  // Only the rep's own records are offered.
  await expect(leadSelect.locator(`option[value="${ids['rel-colleague']}"]`)).toHaveCount(0);
  await leadSelect.selectOption(ids['rel-trial']);
  await expect(dialog.getByTestId('plan-meeting-title-input')).toHaveValue(`Meeting with Cal lead-trial ${STAMP}`);
  await dialog.getByTestId('plan-meeting-date').fill(tomorrowKey);
  await dialog.getByTestId('plan-meeting-time').fill('10:30');
  await dialog.getByTestId('plan-meeting-submit').click();
  await expect(dialog).toHaveCount(0);

  const created = await prisma.meeting.findFirst({ where: { relationId: ids['rel-trial'], status: 'SCHEDULED' } });
  expect(created?.title).toBe(`Meeting with Cal lead-trial ${STAMP}`);
  expect(created?.durationMinutes).toBe(60);
  // On the rep's clock, the day and time they picked.
  expect(localDay(created!.scheduledAt!)).toBe(tomorrowKey);

  // The calendar shows it on that day.
  await page.getByTestId('calendar-view-day').click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByTestId(`calendar-day-${tomorrowKey}`).getByTestId(`calendar-event-meeting-${created!.id}`)).toBeVisible({ timeout: 20_000 });

  // The lead page plans the same, the lead fixed.
  await gotoSettled(page, `/sales/leads/${ids['rel-meet']}`);
  await page.getByTestId('sales-lead-plan-meeting').click();
  await expect(page.getByTestId('plan-meeting-lead-fixed')).toContainText(`Cal lead-meet ${STAMP}`);
  await page.getByTestId('plan-meeting-cancel').click();
  await expect(page.getByTestId('plan-meeting-dialog')).toHaveCount(0);
});

test("the rep's follow-ups are in their calendar subscription", async ({ request }) => {
  const token = `salescal${crypto.randomBytes(16).toString('hex')}`;
  await prisma.user.update({ where: { id: ids.rep }, data: { icsFeedToken: token } });
  const feed = await request.get(`/api/calendar/feed/${token}`);
  expect(feed.status()).toBe(200);
  const ics = await feed.text();
  expect(ics).toContain(`followup-${ids['rel-follow']}`);
  expect(ics).not.toContain(`followup-${ids['rel-colleague']}`);
  // Title and time only: no lead name, no note.
  expect(ics).not.toContain('Send the price sheet');
  expect(ics).not.toContain(`Cal lead-follow ${STAMP}`);
});

test('an INTERNSHIP user cannot open the sales calendar', async ({ page }) => {
  test.slow();
  await signInAndSettle(page, mail.intMentor, PW, '/mentor');
  await page.goto('/sales/calendar');
  await page.waitForURL((u) => !u.pathname.startsWith('/sales'));
  expect(new URL(page.url()).pathname).toBe('/mentor');
  const api = await page.request.get(`/api/sales/calendar?from=${todayKey}&to=${todayKey}`);
  expect(api.status()).toBe(403);
  expect((await api.json()).code).toBe('vertical_unavailable');
});

test('"Today" on /sales lists the follow-ups due and overdue, today\'s meetings and open to-dos, each a link', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mail.rep, PW, '/sales');
  await gotoSettled(page, '/sales');
  const card = page.getByTestId('sales-today');
  await expect(card).toBeVisible();

  // Follow-ups: today's and the overdue one (flagged), never the colleague's.
  const due = card.getByTestId(`sales-today-followup-${ids['rel-follow']}`);
  await expect(due).toContainText(`Cal lead-follow ${STAMP}`);
  await expect(due).toContainText('Send the price sheet');
  await expect(due).toHaveAttribute('data-overdue', 'false');
  const late = card.getByTestId(`sales-today-followup-${ids['rel-overdue']}`);
  await expect(late).toHaveAttribute('data-overdue', 'true');
  await expect(late).toContainText('Overdue');
  await expect(card.getByTestId(`sales-today-followup-${ids['rel-colleague']}`)).toHaveCount(0);
  await expect(card).not.toContainText('Colleague step');

  // Today's meeting, at its time on the rep's clock.
  const meeting = card.getByTestId(`sales-today-meeting-${ids.meeting}`);
  await expect(meeting).toContainText(`Discovery call ${STAMP}`);
  await expect(meeting).toHaveAttribute('href', `/sales/leads/${ids['rel-meet']}`);
  await expect(card).not.toContainText(`Colleague call ${STAMP}`);

  // The open to-do.
  const todo = card.getByTestId(`sales-today-todo-${ids.todo}`);
  await expect(todo).toContainText(`Prepare the demo deck ${STAMP}`);
  await expect(todo).toHaveAttribute('href', '/todos');

  // Each line goes where the work is done.
  await late.click();
  await page.waitForURL(`**/sales/leads/${ids['rel-overdue']}`);
  await expect(page.getByTestId('sales-lead-name')).toHaveText(`Cal lead-overdue ${STAMP}`);
  await gotoSettled(page, '/sales');
  await page.getByTestId(`sales-today-todo-${ids.todo}`).click();
  await page.waitForURL('**/todos');
  await expect(page.getByText(`Prepare the demo deck ${STAMP}`).first()).toBeVisible({ timeout: 20_000 });
});

test('the Team view shows colleagues\' meetings and follow-up days with their initials, opening the lead read-only — never a title or a note', async ({ page, playwright, baseURL }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mail.rep, PW, '/sales');
  await gotoSettled(page, '/sales/calendar');
  await page.getByTestId('sales-calendar-scope-team').click();
  await expect(page.getByTestId('sales-calendar-scope-team')).toHaveAttribute('aria-pressed', 'true');

  const day = page.getByTestId(`calendar-day-${todayKey}`);
  const theirs = day.getByTestId(`calendar-event-team-meeting-${ids.colleagueMeeting}`);
  await expect(theirs).toBeVisible({ timeout: 20_000 });
  await expect(theirs).toContainText(`Cal lead-colleague ${STAMP}`);
  // The week column renders a phone and a desktop form of each row; both name the owner.
  await expect(theirs.getByTestId('calendar-event-owner').first()).toContainText(`Cal colleague ${STAMP}`);
  // It opens the colleague's lead page, which the team-read rule opens read-only (WP2b).
  await expect(theirs.locator('a').first()).toHaveAttribute('href', `/sales/leads/${ids['rel-colleague']}`);
  // The rep's own items are still there, in full.
  await expect(day.getByTestId(`calendar-event-meeting-${ids.meeting}`)).toBeVisible();
  // The colleague's follow-up DAY is there too (the team sees each other's work, 2026-11-15):
  // on the right day, with the lead's name and the owner — never the note.
  const theirFollowUp = day.getByTestId(`calendar-event-team-followup-${ids['rel-colleague']}`);
  await expect(theirFollowUp).toBeVisible();
  await expect(theirFollowUp).toContainText(`Cal lead-colleague ${STAMP}`);
  await expect(theirFollowUp).toContainText('All day');
  await expect(theirFollowUp.getByTestId('calendar-event-owner').first()).toContainText(`Cal colleague ${STAMP}`);
  // Never the colleague's meeting title or follow-up note.
  await expect(page.getByText(`Colleague call ${STAMP}`)).toHaveCount(0);
  await expect(page.getByText('Colleague step')).toHaveCount(0);

  // The API says the same; an ADMIN of the org gets the colleague's follow-up DAY, never its note.
  const rep = await repJar(playwright, baseURL, 'rep');
  const repBody = await (await rep.get(`/api/sales/calendar/team?from=${todayKey}&to=${todayKey}`)).text();
  expect(repBody).toContain(`team-meeting-${ids.colleagueMeeting}`);
  expect(repBody).not.toContain(`Colleague call ${STAMP}`);
  // The rep gets the colleague's follow-up day — the date, the lead, the owner — and no note anywhere in the answer.
  const repEvents = JSON.parse(repBody).events as Array<{ id: string; title: string; date: string; who: string; owner?: string; ownerName?: string }>;
  const repFollowUp = repEvents.find((e) => e.id === `team-followup-${ids['rel-colleague']}`);
  expect(repFollowUp, 'the rep sees the colleague follow-up day').toBeTruthy();
  expect(repFollowUp!.date).toBe(todayKey);
  expect(repFollowUp!.who).toBe(`Cal lead-colleague ${STAMP}`);
  expect(repFollowUp!.ownerName).toBe(`Cal colleague ${STAMP}`);
  expect(repFollowUp!.title).toBe('');
  expect(repBody).not.toContain('Colleague step');
  await rep.dispose();
  const admin = await repJar(playwright, baseURL, 'admin');
  const adminRes = await admin.get(`/api/sales/calendar/team?from=${todayKey}&to=${todayKey}`);
  expect(adminRes.status()).toBe(200);
  const adminEvents = (await adminRes.json()).events as Array<{ id: string; title: string; owner?: string }>;
  const followUp = adminEvents.find((e) => e.id === `team-followup-${ids['rel-colleague']}`);
  expect(followUp, 'the admin sees the colleague follow-up day').toBeTruthy();
  expect(followUp!.title).toBe('');
  expect(JSON.stringify(adminEvents)).not.toContain('Colleague step');
  await admin.dispose();
});

test('with the team book switched off for reps, the Team view is not offered and its API is a 404', async ({ page, playwright, baseURL }) => {
  test.slow();
  await writeSetting('salesTeamBookForReps', 'false', ids.orgA);
  try {
    const rep = await repJar(playwright, baseURL, 'rep');
    expect((await rep.get(`/api/sales/calendar/team?from=${todayKey}&to=${todayKey}`)).status()).toBe(404);
    await rep.dispose();
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, mail.rep, PW, '/sales');
    await gotoSettled(page, '/sales/calendar');
    await expect(page.getByTestId(`calendar-event-meeting-${ids.meeting}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('sales-calendar-scope')).toHaveCount(0);
  } finally {
    await writeSetting('salesTeamBookForReps', 'true', ids.orgA);
  }
});
