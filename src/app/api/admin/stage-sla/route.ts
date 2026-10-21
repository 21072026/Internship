import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { getLocale } from '@/i18n/server';
import { resolveStageEscalations, resolveStageSlas, resolveStageWipLimits } from '@/lib/stageSla';
import { getSetting, setSetting } from '@/lib/settings';
import { isValidTimeZone } from '@/lib/timezone';
import { parseWorkingDays } from '@/lib/businessDays';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { resolveOrgWipLimit } from '@/lib/boardWip';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';

// Per-stage service levels (#817).
//
// NOT gated behind a plan: custom pipeline STAGES are premium, but "how long
// may somebody wait here" is about candidate experience, which this product
// keeps in the free core. It is also why the SLA lives in its own table rather
// than as a column on PipelineStage — that editor is premium and rewrites its
// whole set on every save.

const schema = z.object({
  slas: z
    .array(
      z.object({
        stageKey: z.string().min(1).max(60),
        // 0 or null removes the SLA for that stage — an org can always go back
        // to "no rule here" without deleting anything else.
        days: z.number().int().min(0).max(365).nullable(),
        // Board WIP limit for this stage (#1439). OPTIONAL, and the difference
        // matters: an omitted key leaves the stored limit alone (a programme
        // template posts service levels only — src/lib/programTemplates.ts —
        // and must not wipe the board configuration on its way through), while
        // an explicit null clears it back to "inherit the org-wide setting".
        // A 0 is kept as 0: "never warn about this stage".
        wipLimit: z.number().int().min(0).max(9999).nullable().optional(),
        // The ladder's second rung (#1722): days after the breach before the
        // org's administrators are told. Optional with the same meaning as
        // wipLimit — omitted keeps what is stored, null (or 0) clears it.
        escalateAfterDays: z.number().int().min(0).max(365).nullable().optional(),
      })
    )
    .max(60),
  // How the days are counted (#1638). Optional: a programme template posts
  // service levels only and must not reset the org's day rule on its way.
  dayRule: z
    .object({
      mode: z.string().max(16),
      workingDays: z.array(z.number().int().min(1).max(7)).max(7),
      holidayCalendarId: z.string().max(40).nullable(),
      timeZone: z.string().max(64).nullable(),
    })
    .optional(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    // The labels are printed straight into the settings card, so they need the
    // viewer's locale — without it the whole list read English (#2268).
    const stages = await resolvePipelineStages(orgId, await getLocale());
    const slas = await resolveStageSlas(orgId);
    const wipLimits = await resolveStageWipLimits(orgId);
    const escalations = await resolveStageEscalations(orgId);
    // The org-wide fallback the board applies to a stage with no limit of its
    // own (#1439). Served here rather than read from /api/admin/settings by the
    // board: this is already the one request that answers "what applies to each
    // column", and two sources for one number is how the hardcoded 8 survived.
    const defaultWipLimit = resolveOrgWipLimit(await getSetting('boardWipLimit', await settingsOrgOf(session)));
    // How the days are counted (#1638), and the calendars an admin can pick.
    const settingsOrg = await settingsOrgOf(session);
    const dayRule = {
      mode: await getSetting('slaDayMode', settingsOrg),
      workingDays: [...parseWorkingDays(await getSetting('slaWorkingDays', settingsOrg))],
      holidayCalendarId: (await getSetting('slaHolidayCalendarId', settingsOrg)) || null,
      timeZone: (await getSetting('slaTimeZone', settingsOrg)) || null,
    };
    const calendars = orgId
      ? (
          await prisma.holidayCalendar.findMany({
            where: { orgId },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, _count: { select: { holidays: true } } },
          })
        ).map((c) => ({ id: c.id, name: c.name, count: c._count.holidays }))
      : [];
    // Every stage is listed, configured or not, so the form shows the whole
    // pipeline rather than only the rules that already exist.
    return NextResponse.json({
      dayRule,
      calendars,
      defaultWipLimit,
      stages: stages.map((s) => ({
        key: s.key,
        label: s.label,
        isOffPath: s.isOffPath,
        isTerminal: s.isTerminal,
        days: slas.get(s.key) ?? null,
        wipLimit: wipLimits.get(s.key) ?? null,
        escalateAfterDays: escalations.get(s.key) ?? null,
      })),
    });
  });
}

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }

    // The day rule (#1638), validated before anything is written: a mode off
    // the whitelist, an empty working week, an unknown zone or another
    // tenant's calendar is refused rather than half-applied.
    const rule = parsed.data.dayRule;
    if (rule) {
      const bad = (msg: string) =>
        NextResponse.json({ error: 'Validation failed', details: { formErrors: [msg] } }, { status: 400 });
      if (rule.mode !== 'calendar' && rule.mode !== 'business') return bad('Unknown day mode');
      if (rule.workingDays.length === 0) return bad('Pick at least one working day');
      if (rule.timeZone && !isValidTimeZone(rule.timeZone)) return bad('Unknown time zone');
      if (rule.holidayCalendarId) {
        const own = await prisma.holidayCalendar.count({ where: { id: rule.holidayCalendarId, orgId } });
        if (!own) return bad('Unknown holiday calendar');
      }
    }

    const known = new Set((await resolvePipelineStages(orgId)).map((s) => s.key));
    const unknown = parsed.data.slas.filter((s) => !known.has(s.stageKey)).map((s) => s.stageKey);
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: 'Validation failed', details: { formErrors: [`Unknown stages: ${unknown.join(', ')}`] } },
        { status: 400 }
      );
    }

    // The row now carries two independent numbers (#1439), so what to do with
    // it is decided per stage from BOTH: it survives while either one is set,
    // and is deleted only when neither is. The wipLimit the caller did not
    // mention is whatever is stored — hence reading the current rows first.
    const current = new Map(
      (
        await prisma.stageSla.findMany({
          where: { orgId, stageKey: { in: parsed.data.slas.map((s) => s.stageKey) } },
          select: { stageKey: true, wipLimit: true, escalateAfterDays: true },
        })
      ).map((r) => [r.stageKey, r])
    );

    const keep: { stageKey: string; days: number | null; wipLimit: number | null; escalateAfterDays: number | null }[] = [];
    const drop: string[] = [];
    for (const s of parsed.data.slas) {
      const days = s.days != null && s.days > 0 ? s.days : null;
      const wipLimit = s.wipLimit === undefined ? (current.get(s.stageKey)?.wipLimit ?? null) : s.wipLimit;
      const storedEscalation = current.get(s.stageKey)?.escalateAfterDays ?? null;
      const asked = s.escalateAfterDays === undefined ? storedEscalation : s.escalateAfterDays;
      // An escalation hangs off a service level: without `days` there is no
      // breach to escalate, so it is cleared rather than kept dormant.
      const escalateAfterDays = days != null && asked != null && asked > 0 ? asked : null;
      if (days == null && wipLimit == null) drop.push(s.stageKey);
      else keep.push({ stageKey: s.stageKey, days, wipLimit, escalateAfterDays });
    }

    await prisma.$transaction([
      ...(drop.length > 0
        ? [prisma.stageSla.deleteMany({ where: { orgId, stageKey: { in: drop } } })]
        : []),
      ...keep.map((s) =>
        prisma.stageSla.upsert({
          where: { orgId_stageKey: { orgId, stageKey: s.stageKey } },
          update: { days: s.days, wipLimit: s.wipLimit, escalateAfterDays: s.escalateAfterDays },
          create: { orgId, stageKey: s.stageKey, days: s.days, wipLimit: s.wipLimit, escalateAfterDays: s.escalateAfterDays },
        })
      ),
    ]);

    if (rule) {
      const settingsOrg = await settingsOrgOf(session);
      await setSetting('slaDayMode', rule.mode, settingsOrg);
      await setSetting('slaWorkingDays', [...new Set(rule.workingDays)].sort().join(','), settingsOrg);
      await setSetting('slaHolidayCalendarId', rule.holidayCalendarId ?? '', settingsOrg);
      await setSetting('slaTimeZone', rule.timeZone ?? '', settingsOrg);
    }

    const withSla = keep.filter((s) => s.days != null).length;
    const withWip = keep.filter((s) => s.wipLimit != null).length;
    const withEscalation = keep.filter((s) => s.escalateAfterDays != null).length;

    await logActivity({
      action: 'stage_sla.updated',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'organization',
      targetId: orgId,
      detail: `${withSla} service levels${rule ? ` (${rule.mode} days)` : ''}, ${withEscalation} escalations, ${withWip} WIP limits, ${drop.length} cleared`,
      request,
    });

    return NextResponse.json({ ok: true, configured: withSla, wipConfigured: withWip });
  });
}
