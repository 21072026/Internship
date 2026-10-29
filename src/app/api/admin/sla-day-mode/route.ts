import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { resolveSetting } from '@/lib/settingsResolver';
import { revertSetting, writeSetting } from '@/lib/settingsWrite';
import { isValidTimeZone } from '@/lib/timezone';
import { parseWorkingDays } from '@/lib/businessDays';

// How a stage SLA counts days (#1638): calendar (the default, today's
// behaviour) or business days with working days, a zone and a holiday
// calendar. Four settings on the chain, edited together for the org or one
// programme (a Cohort). docs/business-day-slas.md.

const KEYS = ['slaDayMode', 'slaWorkingDays', 'slaTimeZone', 'slaHolidayCalendarId'] as const;

async function programOf(orgId: string, programId: string | null): Promise<{ programId: string | null } | null> {
  if (!programId) return { programId: null };
  const program = await prisma.cohort.findFirst({ where: { id: programId, orgId }, select: { id: true } });
  // Another tenant's programme reads as missing, never as forbidden.
  return program ? { programId: program.id } : null;
}

export async function GET(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = await settingsOrgOf(gate.session);
  const requested = new URL(request.url).searchParams.get('programId');
  return withTenantScope(gate.session, async () => {
    const scope = await programOf(orgId, requested);
    if (!scope) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const at = { orgId, programId: scope.programId };
    const [mode, workingDays, timeZone, calendarId, overridden, calendars, programs] = await Promise.all([
      resolveSetting('slaDayMode', at),
      resolveSetting('slaWorkingDays', at),
      resolveSetting('slaTimeZone', at),
      resolveSetting('slaHolidayCalendarId', at),
      scope.programId
        ? prisma.setting.count({ where: { orgId, programId: scope.programId, key: { in: [...KEYS] } } })
        : Promise.resolve(0),
      prisma.holidayCalendar.findMany({ where: { orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.cohort.findMany({ where: { orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 200 }),
    ]);
    return NextResponse.json({
      programId: scope.programId,
      mode,
      workingDays: parseWorkingDays(workingDays),
      timeZone,
      calendarId,
      // A programme row exists for at least one key: the scope does not just inherit.
      overridden: overridden > 0,
      calendars,
      programs,
    });
  });
}

const schema = z.object({
  programId: z.string().min(1).max(191).nullable().optional(),
  mode: z.enum(['calendar', 'business']),
  workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  timeZone: z.string().max(64).refine((v) => v === '' || isValidTimeZone(v), 'unknown time zone'),
  calendarId: z.string().max(191),
});

// PUT — store the four values at the chosen layer.
export async function PUT(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const orgId = await settingsOrgOf(session);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const body = parsed.data;
  return withTenantScope(session, async () => {
    const scope = await programOf(orgId, body.programId ?? null);
    if (!scope) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // A calendar id must be one of this org's; anything else is refused, not stored.
    if (body.calendarId && !(await prisma.holidayCalendar.count({ where: { id: body.calendarId, orgId } }))) {
      return NextResponse.json({ error: 'Calendar not found', code: 'calendar_not_found' }, { status: 404 });
    }
    const opts = { ...(scope.programId ? { programId: scope.programId } : {}), actor: { id: session.user.id, email: session.user.email ?? null } };
    const values: Record<(typeof KEYS)[number], string> = {
      slaDayMode: body.mode,
      slaWorkingDays: [...new Set(body.workingDays)].sort((a, b) => a - b).join(','),
      slaTimeZone: body.timeZone,
      slaHolidayCalendarId: body.calendarId,
    };
    for (const key of KEYS) await writeSetting(key, values[key], orgId, opts);
    await logActivity({
      action: 'settings.sla_day_mode',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      detail: `${scope.programId ? `program=${scope.programId}` : 'org'} mode=${body.mode}`,
      request,
      orgId,
    });
    return NextResponse.json({ ok: true });
  });
}

// DELETE ?programId= — a programme goes back to inheriting the org's rule.
export async function DELETE(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const orgId = await settingsOrgOf(session);
  const requested = new URL(request.url).searchParams.get('programId');
  if (!requested) return NextResponse.json({ error: 'programId required' }, { status: 400 });
  return withTenantScope(session, async () => {
    const scope = await programOf(orgId, requested);
    if (!scope?.programId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const opts = { programId: scope.programId, actor: { id: session.user.id, email: session.user.email ?? null } };
    for (const key of KEYS) await revertSetting(key, orgId, opts);
    return NextResponse.json({ ok: true });
  });
}
