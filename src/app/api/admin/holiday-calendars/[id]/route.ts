import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { parseHolidayList } from '@/lib/businessDays';
import { MAX_HOLIDAYS_PER_CALENDAR, calendarBody, serializeCalendar } from '@/lib/holidayCalendars';

// One holiday calendar (#1638). Another org's id is a 404.

type Ctx = { params: Promise<{ id: string }> };

// PUT — rename and REPLACE the holiday list with the pasted one, in one transaction.
export async function PUT(request: Request, { params }: Ctx) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  const orgId = await settingsOrgOf(session);
  const parsed = calendarBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { holidays, invalidLines } = parseHolidayList(parsed.data.text);
  if (invalidLines.length) return NextResponse.json({ error: 'Unreadable lines', code: 'invalid_lines', invalidLines }, { status: 400 });
  if (holidays.length > MAX_HOLIDAYS_PER_CALENDAR) return NextResponse.json({ error: 'Too many holidays', code: 'too_many' }, { status: 400 });
  return withTenantScope(session, async () => {
    const owned = await prisma.holidayCalendar.findFirst({ where: { id, orgId }, select: { id: true } });
    if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const calendar = await prisma.$transaction(async (tx) => {
      await tx.holiday.deleteMany({ where: { calendarId: owned.id } });
      return tx.holidayCalendar.update({
        where: { id: owned.id },
        data: {
          name: parsed.data.name,
          holidays: { create: holidays.map((h) => ({ date: new Date(`${h.date}T00:00:00Z`), label: h.label })) },
        },
        select: { id: true, name: true, holidays: { select: { date: true, label: true }, orderBy: { date: 'asc' } } },
      });
    });
    await logActivity({ action: 'settings.holiday_calendar_updated', actorId: session.user.id, targetType: 'HolidayCalendar', targetId: owned.id, request, orgId });
    return NextResponse.json({ calendar: serializeCalendar(calendar) });
  });
}

// DELETE — the calendar and its dates. A scope still pointing at it reads as
// "no calendar" (resolveSlaDayRule), so a deadline loses the holidays, never fails.
export async function DELETE(request: Request, { params }: Ctx) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  const orgId = await settingsOrgOf(session);
  return withTenantScope(session, async () => {
    const { count } = await prisma.holidayCalendar.deleteMany({ where: { id, orgId } });
    if (count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await logActivity({ action: 'settings.holiday_calendar_deleted', actorId: session.user.id, targetType: 'HolidayCalendar', targetId: id, request, orgId });
    return NextResponse.json({ ok: true });
  });
}
