import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { parseHolidayList } from '@/lib/businessDays';
import { MAX_CALENDARS_PER_ORG, MAX_HOLIDAYS_PER_CALENDAR, calendarBody, serializeCalendar } from '@/lib/holidayCalendars';

// Holiday calendars for business-day SLAs (#1638). ADMIN of the org only
// (org.settings.write, checked here); every row is the caller's org's. The
// holidays are a pasted `YYYY-MM-DD, label` list — no third-party holiday API.

export async function GET(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = await settingsOrgOf(gate.session);
  return withTenantScope(gate.session, async () => {
    const calendars = await prisma.holidayCalendar.findMany({
      where: { orgId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, holidays: { select: { date: true, label: true }, orderBy: { date: 'asc' } } },
    });
    return NextResponse.json({ calendars: calendars.map(serializeCalendar) });
  });
}

export async function POST(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const orgId = await settingsOrgOf(session);
  const parsed = calendarBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { holidays, invalidLines } = parseHolidayList(parsed.data.text);
  if (invalidLines.length) return NextResponse.json({ error: 'Unreadable lines', code: 'invalid_lines', invalidLines }, { status: 400 });
  if (holidays.length > MAX_HOLIDAYS_PER_CALENDAR) return NextResponse.json({ error: 'Too many holidays', code: 'too_many' }, { status: 400 });
  return withTenantScope(session, async () => {
    if ((await prisma.holidayCalendar.count({ where: { orgId } })) >= MAX_CALENDARS_PER_ORG) {
      return NextResponse.json({ error: 'Too many calendars', code: 'calendar_limit' }, { status: 409 });
    }
    const calendar = await prisma.holidayCalendar.create({
      data: {
        orgId,
        name: parsed.data.name,
        holidays: { create: holidays.map((h) => ({ date: new Date(`${h.date}T00:00:00Z`), label: h.label })) },
      },
      select: { id: true, name: true, holidays: { select: { date: true, label: true }, orderBy: { date: 'asc' } } },
    });
    await logActivity({ action: 'settings.holiday_calendar_created', actorId: session.user.id, targetType: 'HolidayCalendar', targetId: calendar.id, request, orgId });
    return NextResponse.json({ calendar: serializeCalendar(calendar) }, { status: 201 });
  });
}
