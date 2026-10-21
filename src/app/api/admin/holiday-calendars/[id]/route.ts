import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveOrgId } from '@/lib/orgScope';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { parseHolidayList } from '@/lib/businessDays';
import { calendarSchema, MAX_HOLIDAYS } from '@/lib/holidayCalendarAdmin';

// One holiday calendar (#1638): replace its name and dates, or delete it. The
// org is part of every WHERE, so another tenant's id answers 404 like one that
// does not exist. Deleting the calendar an org counts with leaves the setting
// pointing nowhere, which reads as "no holidays" (stageSla.ts only reads a
// calendar of the same org).

// The ADMIN + own-org gate, in this file so the route-auth and OpenAPI
// analysers can follow it (#2444).
async function adminOrg() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const orgId = resolveOrgId(session);
  if (!orgId) return { error: NextResponse.json({ error: 'No organization' }, { status: 400 }) };
  return { session, orgId };
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await adminOrg();
  if ('error' in gate) return gate.error;
  const { id } = await params;
  const parsed = calendarSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { rows, rejected } = parseHolidayList(parsed.data.text);
  if (rows.length > MAX_HOLIDAYS) return NextResponse.json({ error: 'Too many dates', code: 'too_many' }, { status: 400 });
  return await withTenantScope(gate.session, async () => {
    const own = await prisma.holidayCalendar.findFirst({ where: { id, orgId: gate.orgId }, select: { id: true } });
    if (!own) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await prisma.$transaction([
      prisma.holidayCalendar.update({ where: { id }, data: { name: parsed.data.name } }),
      prisma.holiday.deleteMany({ where: { calendarId: id } }),
      prisma.holiday.createMany({
        data: rows.map((r) => ({ calendarId: id, date: new Date(`${r.date}T00:00:00Z`), label: r.label })),
      }),
    ]);
    await logActivity({
      orgId: gate.orgId,
      action: 'holiday_calendar.updated',
      actorId: gate.session.user.id,
      actorEmail: gate.session.user.email ?? null,
      targetType: 'holiday_calendar',
      targetId: id,
      detail: `${rows.length} dates`,
      request,
    });
    return NextResponse.json({ id, saved: rows.length, rejected });
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await adminOrg();
  if ('error' in gate) return gate.error;
  const { id } = await params;
  return await withTenantScope(gate.session, async () => {
    const { count } = await prisma.holidayCalendar.deleteMany({ where: { id, orgId: gate.orgId } });
    if (count !== 1) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await logActivity({
      orgId: gate.orgId,
      action: 'holiday_calendar.deleted',
      actorId: gate.session.user.id,
      actorEmail: gate.session.user.email ?? null,
      targetType: 'holiday_calendar',
      targetId: id,
      request,
    });
    return NextResponse.json({ ok: true });
  });
}
