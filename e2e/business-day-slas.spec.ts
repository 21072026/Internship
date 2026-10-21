import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, userInWorld } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { addBusinessDays } from '@/lib/businessDays';

// #1638 — business-day stage SLAs with a holiday calendar, per org. Calendar
// days stay the default (pinned by e2e/stage-sla.spec.ts); here an org opts in,
// a stage move gets a business-day deadline that skips its holiday, and the
// calendar routes refuse another tenant's calendar.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const STAGE = 'INTERVIEW_PENDING_250';
const TZ = 'Europe/Berlin';
const DAY = 24 * 60 * 60 * 1000;

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an org on business days gets deadlines that skip weekends and its holidays; calendars stay in their org', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const admin = await userInWorld(ADMIN_EMAIL, 'INTERNSHIP', { id: true, orgId: true });
  const orgId = admin!.orgId!;
  const other = await prisma.organization.create({ data: { name: 'Holiday Other Org', slug: `holiday-other-${Date.now()}` } });
  const foreign = await prisma.holidayCalendar.create({ data: { orgId: other.id, name: 'Foreign' } });
  const priorSla = await prisma.stageSla.findUnique({ where: { orgId_stageKey: { orgId, stageKey: STAGE } } });
  const mentorEmail = uniqueEmail('bday-mentor');
  const menteeEmail = uniqueEmail('bday-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Bday Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Bday Mentee');
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id] } }, data: { orgId } });
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId, status: 'ACTIVE', pipelineStatus: 'APPROVAL_PENDING_220' },
  });
  let calendarId: string | null = null;

  // The next two local dates as holidays; the expected deadline is computed
  // with the same pure helper, so the assertion holds on any weekday.
  const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
  const holidays = [1, 2].map((n) => ymd(new Date(Date.now() + n * DAY)));

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    const created = await page.request.post('/api/admin/holiday-calendars', {
      data: { name: 'Test holidays', text: `${holidays[0]}, First\n${holidays[1]}, Second\nnot a date` },
    });
    expect(created.ok()).toBeTruthy();
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({ saved: 2, rejected: [3] });
    calendarId = createdBody.id;

    // Another tenant's calendar: invisible, unwritable, undeletable, unselectable.
    const list = await (await page.request.get('/api/admin/holiday-calendars')).json();
    expect(list.calendars.map((c: { id: string }) => c.id)).not.toContain(foreign.id);
    expect((await page.request.put(`/api/admin/holiday-calendars/${foreign.id}`, { data: { name: 'x', text: '' } })).status()).toBe(404);
    expect((await page.request.delete(`/api/admin/holiday-calendars/${foreign.id}`)).status()).toBe(404);
    const pickForeign = await page.request.put('/api/admin/stage-sla', {
      data: {
        slas: [{ stageKey: STAGE, days: 3 }],
        dayRule: { mode: 'business', workingDays: [1, 2, 3, 4, 5], holidayCalendarId: foreign.id, timeZone: TZ },
      },
    });
    expect(pickForeign.status()).toBe(400);

    const saved = await page.request.put('/api/admin/stage-sla', {
      data: {
        slas: [{ stageKey: STAGE, days: 3 }],
        dayRule: { mode: 'business', workingDays: [1, 2, 3, 4, 5], holidayCalendarId: calendarId, timeZone: TZ },
      },
    });
    expect(saved.ok()).toBeTruthy();
    const read = await (await page.request.get('/api/admin/stage-sla')).json();
    expect(read.dayRule).toMatchObject({ mode: 'business', holidayCalendarId: calendarId, timeZone: TZ });

    const before = Date.now();
    const moved = await page.request.put(`/api/mentorship/${rel.id}`, { data: { pipelineStatus: STAGE } });
    expect(moved.ok()).toBeTruthy();
    const after = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.id } });
    const expected = addBusinessDays(new Date(before), 3, {
      workingDays: new Set([1, 2, 3, 4, 5]),
      holidays: new Set(holidays),
      timeZone: TZ,
    });
    expect(Math.abs(after.stageDeadline!.getTime() - expected.getTime())).toBeLessThan(60 * 1000);
    // Never sooner than plain calendar days would have been.
    expect(after.stageDeadline!.getTime()).toBeGreaterThan(before + 3 * DAY);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await prisma.setting.deleteMany({ where: { orgId, key: { in: ['slaDayMode', 'slaWorkingDays', 'slaHolidayCalendarId', 'slaTimeZone'] } } });
    if (calendarId) await prisma.holidayCalendar.deleteMany({ where: { id: calendarId } });
    if (priorSla) await prisma.stageSla.update({ where: { id: priorSla.id }, data: { days: priorSla.days } });
    else await prisma.stageSla.deleteMany({ where: { orgId, stageKey: STAGE } });
    await prisma.organization.delete({ where: { id: other.id } }).catch(() => {});
  }
});
