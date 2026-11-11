import { test, expect } from '@playwright/test';
import { prisma, seedCustomPipelineOrg, cleanupCustomPipelineOrg } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { addBusinessDays } from '../prisma/business-days.mjs';

// Business-day stage SLAs (#1638): an admin switches the org to business days
// with a holiday calendar, a relation moves into a 3-day stage, and its deadline
// is three WORKING days later — computed by the same pure function. Calendar
// mode (the default) stays `now + 3 × 24h`. Another org's calendar is a 404 and
// cannot be referenced from a setting.

const PASSWORD = 'BusinessDayPass123!';
let seeded: Awaited<ReturnType<typeof seedCustomPipelineOrg>>;

test.beforeAll(async () => {
  seeded = await seedCustomPipelineOrg('bizdays', PASSWORD);
  await prisma.stageSla.create({ data: { orgId: seeded.org.id, stageKey: 'STAGE_B', days: 3 } });
  await prisma.stageSla.create({ data: { orgId: seeded.org.id, stageKey: 'STAGE_C', days: 3 } });
});

test.afterAll(async () => {
  await prisma.setting.deleteMany({ where: { orgId: seeded.org.id } });
  await prisma.holidayCalendar.deleteMany({ where: { orgId: seeded.org.id } });
  await prisma.stageSla.deleteMany({ where: { orgId: seeded.org.id } });
  await prisma.domainEvent.deleteMany({ where: { orgId: seeded.org.id } });
  await prisma.activityLog.deleteMany({ where: { orgId: seeded.org.id } });
  await cleanupCustomPipelineOrg(seeded.org.id, seeded.emails);
  await prisma.$disconnect();
});

test('calendar by default; business days with a holiday once switched on', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAndSettle(page, seeded.adminEmail, PASSWORD, '/admin');
  const move = async (from: string, to: string) => {
    const before = Date.now();
    const res = await page.request.post('/api/status-changes', { data: { relationId: seeded.relationId, fromStatus: from, toStatus: to } });
    expect(res.status()).toBe(201);
    const after = Date.now();
    const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId }, select: { stageDeadline: true } });
    return { before, after, deadline: rel.stageDeadline!.getTime() };
  };

  // Default: calendar days, exactly as before.
  const cal = await move('STAGE_F', 'STAGE_B');
  expect(cal.deadline).toBeGreaterThanOrEqual(cal.before + 3 * 86_400_000 - 1000);
  expect(cal.deadline).toBeLessThanOrEqual(cal.after + 3 * 86_400_000 + 1000);

  // A holiday calendar covering the next working days, then business mode.
  const tz = 'Europe/Berlin';
  const nextDays = Array.from({ length: 10 }, (_, i) => new Date(Date.now() + (i + 1) * 86_400_000));
  const isoLocal = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const holidays = [isoLocal(nextDays[0]), isoLocal(nextDays[1])];
  const created = await page.request.post('/api/admin/holiday-calendars', {
    data: { name: 'Test holidays', text: holidays.map((d) => `${d}, Test holiday`).join('\n') },
  });
  expect(created.status()).toBe(201);
  const calendarId = (await created.json()).calendar.id as string;

  // Pasted garbage is refused with the line numbers, not half-stored.
  const bad = await page.request.post('/api/admin/holiday-calendars', { data: { name: 'Bad', text: '2026-02-30, nope\nhello' } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).invalidLines).toEqual([1, 2]);

  const saved = await page.request.put('/api/admin/sla-day-mode', {
    data: { mode: 'business', workingDays: [1, 2, 3, 4, 5], timeZone: tz, calendarId },
  });
  expect(saved.status()).toBe(200);

  const biz = await move('STAGE_B', 'STAGE_C');
  const rule = { workingDays: [1, 2, 3, 4, 5], holidays, timeZone: tz };
  const lo = addBusinessDays(new Date(biz.before - 1000), 3, rule).getTime();
  const hi = addBusinessDays(new Date(biz.after + 1000), 3, rule).getTime();
  expect(biz.deadline).toBeGreaterThanOrEqual(lo);
  expect(biz.deadline).toBeLessThanOrEqual(hi);
  // …and it is later than the calendar answer would have been (two holidays at least).
  expect(biz.deadline).toBeGreaterThan(biz.after + 3 * 86_400_000);
});

test("another org's calendar is not reachable or referenceable", async ({ page }) => {
  const other = await prisma.organization.create({ data: { name: 'Other bizdays org', slug: `other-bizdays-${Date.now()}` } });
  try {
    const foreign = await prisma.holidayCalendar.create({ data: { orgId: other.id, name: 'Foreign' } });
    await signInAndSettle(page, seeded.adminEmail, PASSWORD, '/admin');
    const list = await (await page.request.get('/api/admin/holiday-calendars')).json();
    expect((list.calendars as { id: string }[]).map((c) => c.id)).not.toContain(foreign.id);
    expect((await page.request.put(`/api/admin/holiday-calendars/${foreign.id}`, { data: { name: 'x', text: '' } })).status()).toBe(404);
    expect((await page.request.delete(`/api/admin/holiday-calendars/${foreign.id}`)).status()).toBe(404);
    const ref = await page.request.put('/api/admin/sla-day-mode', {
      data: { mode: 'business', workingDays: [1, 2, 3, 4, 5], timeZone: '', calendarId: foreign.id },
    });
    expect(ref.status()).toBe(404);
  } finally {
    await prisma.holidayCalendar.deleteMany({ where: { orgId: other.id } });
    await prisma.organization.delete({ where: { id: other.id } });
  }
});
