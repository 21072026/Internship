import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveOrgId } from '@/lib/orgScope';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { parseHolidayList } from '@/lib/businessDays';
import { calendarSchema, MAX_HOLIDAYS } from '@/lib/holidayCalendarAdmin';

// Holiday calendars for business-day stage SLAs (#1638). ADMIN only; the org
// comes from the session and every query names it, so another tenant's
// calendar is never listed, read or written. A calendar is a name and a pasted
// `YYYY-MM-DD, label` list — no third-party holiday feed.

// The ADMIN + own-org gate, in this file so the route-auth and OpenAPI
// analysers can follow it (#2444).
async function adminOrg() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const orgId = resolveOrgId(session);
  if (!orgId) return { error: NextResponse.json({ error: 'No organization' }, { status: 400 }) };
  return { session, orgId };
}

export async function GET() {
  const gate = await adminOrg();
  if ('error' in gate) return gate.error;
  return await withTenantScope(gate.session, async () => {
    const calendars = await prisma.holidayCalendar.findMany({
      where: { orgId: gate.orgId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, holidays: { orderBy: { date: 'asc' }, select: { date: true, label: true } } },
    });
    return NextResponse.json({
      calendars: calendars.map((c) => ({
        id: c.id,
        name: c.name,
        holidays: c.holidays.map((h) => ({ date: h.date.toISOString().slice(0, 10), label: h.label })),
      })),
    });
  });
}

export async function POST(request: Request) {
  const gate = await adminOrg();
  if ('error' in gate) return gate.error;
  const parsed = calendarSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { rows, rejected } = parseHolidayList(parsed.data.text);
  if (rows.length > MAX_HOLIDAYS) return NextResponse.json({ error: 'Too many dates', code: 'too_many' }, { status: 400 });
  return await withTenantScope(gate.session, async () => {
    const calendar = await prisma.holidayCalendar.create({
      data: {
        orgId: gate.orgId,
        name: parsed.data.name,
        holidays: { create: rows.map((r) => ({ date: new Date(`${r.date}T00:00:00Z`), label: r.label })) },
      },
      select: { id: true },
    });
    await logActivity({
      orgId: gate.orgId,
      action: 'holiday_calendar.created',
      actorId: gate.session.user.id,
      actorEmail: gate.session.user.email ?? null,
      targetType: 'holiday_calendar',
      targetId: calendar.id,
      detail: `${rows.length} dates`,
      request,
    });
    return NextResponse.json({ id: calendar.id, saved: rows.length, rejected });
  });
}
