import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { getLocale } from '@/i18n/server';
import { resolveStageEscalations, resolveStageSlas, resolveStageWipLimits } from '@/lib/stageSla';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { resolveOrgWipLimit } from '@/lib/boardWip';
import { logActivity } from '@/lib/activity';
import { inheritedSla, resolveSlaDays, slaScopeKey, type SlaScope } from '@/lib/stageSlaRule';
import { loadStageSlaRows } from '@/lib/stageSla';
import { z } from 'zod';

// The org's own rows. Per-cohort / per-mentor overrides (#1640) are other
// scopes of the same table; this form edits the org scope only.
const ORG_SCOPE = slaScopeKey({});

// Per-stage service levels (#817).
//
// NOT gated behind a plan: custom pipeline STAGES are premium, but "how long
// may somebody wait here" is about candidate experience, which this product
// keeps in the free core. It is also why the SLA lives in its own table rather
// than as a column on PipelineStage — that editor is premium and rewrites its
// whole set on every save.

// Per-cohort / per-mentor overrides (#1640). Either id narrows the save to
// that scope; neither is the org's own row (everything this route did before).
// The ids are CHECKED against the caller's org below — never trusted from the
// form, because a row naming another tenant's cohort or mentor would otherwise
// be stored under this org and silently never match anything.
const scopeIds = {
  cohortId: z.string().min(1).max(191).nullable().optional(),
  mentorId: z.string().min(1).max(191).nullable().optional(),
};

const schema = z.object({
  ...scopeIds,
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
});

/**
 * The (cohortId, mentorId) a request names, verified to belong to `orgId`:
 * the cohort must be one of the org's, the mentor a MENTOR of the org.
 * `null` = an id that is not this org's — answered 404 like any other id the
 * caller may not see. An empty object = the org scope.
 */
async function verifiedScope(orgId: string, raw: SlaScope): Promise<SlaScope | null> {
  const cohortId = raw.cohortId || null;
  const mentorId = raw.mentorId || null;
  if (cohortId) {
    const cohort = await prisma.cohort.findFirst({ where: { id: cohortId, orgId }, select: { id: true } });
    if (!cohort) return null;
  }
  if (mentorId) {
    const mentor = await prisma.user.findFirst({ where: { id: mentorId, orgId, role: 'MENTOR' }, select: { id: true } });
    if (!mentor) return null;
  }
  return { cohortId, mentorId };
}

export async function GET(request: Request) {
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
    const defaultWipLimit = resolveOrgWipLimit(await resolveSettingRaw('boardWipLimit', { orgId: await settingsOrgOf(session) }));

    // The override scope the editor is looking at (#1640), and what it offers.
    const url = new URL(request.url);
    const asked = { cohortId: url.searchParams.get('cohortId'), mentorId: url.searchParams.get('mentorId') };
    const scope = orgId ? await verifiedScope(orgId, asked) : {};
    if (!scope) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const isOverride = slaScopeKey(scope) !== ORG_SCOPE;
    const rows = orgId ? await loadStageSlaRows(orgId) : [];
    const own = new Map(
      rows.filter((r) => slaScopeKey(r) === slaScopeKey(scope) && r.days != null).map((r) => [r.stageKey, r.days as number])
    );
    const effective = resolveSlaDays(rows, scope);
    const inherited = inheritedSla(rows, scope);
    const [cohorts, mentors] = orgId
      ? await Promise.all([
          prisma.cohort.findMany({ where: { orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
          prisma.user.findMany({
            where: { orgId, role: 'MENTOR' },
            select: { id: true, fullName: true },
            orderBy: { fullName: 'asc' },
            take: 1000,
          }),
        ])
      : [[], []];

    // Every stage is listed, configured or not, so the form shows the whole
    // pipeline rather than only the rules that already exist.
    return NextResponse.json({
      defaultWipLimit,
      scope: { cohortId: scope.cohortId ?? null, mentorId: scope.mentorId ?? null, override: isOverride },
      cohorts,
      mentors: mentors.map((m) => ({ id: m.id, name: m.fullName })),
      stages: stages.map((s) => ({
        key: s.key,
        label: s.label,
        isOffPath: s.isOffPath,
        isTerminal: s.isTerminal,
        // In an override scope `days` is that scope's OWN number (null = it
        // inherits); `effective`/`inherited` say what applies and from where.
        days: isOverride ? (own.get(s.key) ?? null) : (slas.get(s.key) ?? null),
        effective: effective.get(s.key) ?? null,
        inherited: inherited.get(s.key) ?? null,
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

    const known = new Set((await resolvePipelineStages(orgId)).map((s) => s.key));
    const unknown = parsed.data.slas.filter((s) => !known.has(s.stageKey)).map((s) => s.stageKey);
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: 'Validation failed', details: { formErrors: [`Unknown stages: ${unknown.join(', ')}`] } },
        { status: 400 }
      );
    }

    const scope = await verifiedScope(orgId, { cohortId: parsed.data.cohortId, mentorId: parsed.data.mentorId });
    if (!scope) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const scopeKey = slaScopeKey(scope);
    if (scopeKey !== ORG_SCOPE) {
      // An override carries a service level only: escalation rungs and board
      // WIP limits stay organisation-wide (resolveStageEscalations /
      // resolveStageWipLimits read the org scope), so they are ignored here.
      const set = parsed.data.slas.filter((s) => s.days != null && s.days > 0);
      const cleared = parsed.data.slas.filter((s) => !(s.days != null && s.days > 0)).map((s) => s.stageKey);
      await prisma.$transaction([
        ...(cleared.length > 0
          ? [prisma.stageSla.deleteMany({ where: { orgId, scope: scopeKey, stageKey: { in: cleared } } })]
          : []),
        ...set.map((s) =>
          prisma.stageSla.upsert({
            where: { orgId_stageKey_scope: { orgId, stageKey: s.stageKey, scope: scopeKey } },
            update: { days: s.days },
            create: {
              orgId,
              stageKey: s.stageKey,
              days: s.days,
              cohortId: scope.cohortId ?? null,
              mentorId: scope.mentorId ?? null,
              scope: scopeKey,
            },
          })
        ),
      ]);
      await logActivity({
        action: 'stage_sla.override_updated',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'organization',
        targetId: orgId,
        detail: `scope ${scopeKey}: ${set.length} service levels, ${cleared.length} inherited`,
        request,
      });
      return NextResponse.json({ ok: true, configured: set.length, wipConfigured: 0 });
    }

    // The row now carries two independent numbers (#1439), so what to do with
    // it is decided per stage from BOTH: it survives while either one is set,
    // and is deleted only when neither is. The wipLimit the caller did not
    // mention is whatever is stored — hence reading the current rows first.
    const current = new Map(
      (
        await prisma.stageSla.findMany({
          where: { orgId, scope: ORG_SCOPE, stageKey: { in: parsed.data.slas.map((s) => s.stageKey) } },
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
        ? [prisma.stageSla.deleteMany({ where: { orgId, scope: ORG_SCOPE, stageKey: { in: drop } } })]
        : []),
      ...keep.map((s) =>
        prisma.stageSla.upsert({
          where: { orgId_stageKey_scope: { orgId, stageKey: s.stageKey, scope: ORG_SCOPE } },
          update: { days: s.days, wipLimit: s.wipLimit, escalateAfterDays: s.escalateAfterDays },
          create: { orgId, stageKey: s.stageKey, days: s.days, wipLimit: s.wipLimit, escalateAfterDays: s.escalateAfterDays },
        })
      ),
    ]);

    const withSla = keep.filter((s) => s.days != null).length;
    const withWip = keep.filter((s) => s.wipLimit != null).length;
    const withEscalation = keep.filter((s) => s.escalateAfterDays != null).length;

    await logActivity({
      action: 'stage_sla.updated',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'organization',
      targetId: orgId,
      detail: `${withSla} service levels, ${withEscalation} escalations, ${withWip} WIP limits, ${drop.length} cleared`,
      request,
    });

    return NextResponse.json({ ok: true, configured: withSla, wipConfigured: withWip });
  });
}
