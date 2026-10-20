import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';
import { runUnscoped } from '@/lib/tenantAmbient';
import { outcomeStageKeysFrom, type OutcomeStageKeys } from '@/lib/pipelineStages';
import { defaultPipelineStages, localizeStageLabels, type ResolvedStage } from '@/lib/pipeline';
import { getLocale } from '@/i18n/server';
import { defaultOrgId } from '@/lib/defaultOrg';
import { worldOfOrg } from '@/lib/userWorld';
import { benchmarkOrgKey, orgInWorldWhere } from '@/lib/analyticsScope';
import { benchmarkFigures, MIN_OTHER_PROGRAMS, MIN_RELATIONS, type BenchmarkAgg } from '@/lib/benchmarkPool';

// The anonymity floors (MIN_RELATIONS, MIN_OTHER_PROGRAMS) and the arithmetic
// live in src/lib/benchmarkPool.ts, pure and unit-tested.

// GET — premium cross-program benchmark (Faz 2, #542). Compares the viewer's
// organization's funnel conversion against an ANONYMIZED, aggregated average
// across all qualifying programs. Only aggregate numbers cross the boundary —
// never another program's identity or raw rows. Gated by the org's ADVANCED_ANALYTICS entitlement (#1740).
//
// WHY THE STAGE SET IS RESOLVED PER ORG (#1882)
//
// Every other consumer of pipeline stages answers for ONE tenant, so it resolves
// one stage set. This one deliberately reads across ALL of them, and each row of
// the groupBy belongs to a different program with a different vocabulary. The
// old `new Set(['HIRED_660','EMPLOYED_700'])` therefore did two wrong things at
// once: it zeroed the viewer's own numbers when the viewer had renamed its
// stages, and it zeroed every OTHER program's contribution to the platform
// average — quietly dragging the benchmark down for everybody as soon as one
// customer customised.
//
// So the stage sets are resolved per orgId, from ONE batched `findMany` over the
// orgs the groupBy actually returned (never one query per row, and never once
// for the viewer's own org applied to everybody).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // The CALLER's tier, org passed explicitly (this runs before the scope binds).
  if (!(await entitled(await settingsOrgOf(session), 'ADVANCED_ANALYTICS'))) {
    return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }, { status: 403 });
  }

  const locale = await getLocale();

  return await withTenantScope(session, async () => {
    // Aggregate counts per (org, stage) — never fetch raw relation rows.
    //
    // NOTE, unchanged by #1882 and worth knowing before touching this query:
    // `MentorshipRelation` is a registered tenant model and `groupBy` is one of
    // the actions the middleware injects `orgId` into (src/lib/orgContext.ts),
    // so once `MT_ENFORCE_ISOLATION=true` this groupBy is scoped to the viewer's
    // own org and the "pool" collapses to that one program. That is today's
    // behaviour on `main`; it is a property of the enforcement rollout, not of
    // this change, and deciding whether a cross-tenant benchmark may escape the
    // filter is a privacy call that belongs with the enforcement work rather
    // than here. The code below is correct either way — see the batched read.
    //
    // THE PEER POOL IS THE CALLER'S WORLD (leak audit WP3, docs/worlds.md).
    // Every organization used to feed one pool, so a MARKETING tenant's "platform
    // average" was mostly internship programmes — and vice versa: numbers about
    // the other product, which that tenant has no business seeing even in
    // aggregate, and which compare a sales funnel with a hiring pipeline. The
    // groupBy is narrowed to the orgs of the caller's own vertical; a relation
    // with no org is the default org's and therefore the default world's.
    const fallbackOrgId = await defaultOrgId();
    const myOrgId = resolveOrgId(session) ?? fallbackOrgId;
    const world = await worldOfOrg(myOrgId);
    const grouped = await prisma.mentorshipRelation.groupBy({
      by: ['orgId', 'pipelineStatus'],
      where: orgInWorldWhere(world),
      _count: { _all: true },
    });

    // ── Stage sets, one query for every org in the result ────────────────────
    // The viewer's own org is included even when it contributed no rows to the
    // groupBy: its label is what the card prints, and a brand-new program with
    // a custom pipeline and no relations yet must still be named correctly.
    const orgIds = [
      ...new Set(
        [...grouped.map((g) => g.orgId), myOrgId].filter((id): id is string => !!id),
      ),
    ];
    // Deliberately OUTSIDE the tenant filter. `PipelineStage` is a registered
    // tenant model and the middleware's injection is an OVERWRITE
    // (`{ ...where, orgId }`), so a scoped call would silently replace
    // `orgId: { in: [...] }` with a single id — every other program would fall
    // back to the default catalogue and be mis-counted with no error anywhere.
    // Nothing read here reaches the response: only the VIEWER's own label is
    // returned, and every other org contributes an anonymous count.
    const stageRows = orgIds.length
      ? await runUnscoped(() =>
          prisma.pipelineStage.findMany({
            where: { orgId: { in: orgIds } },
            orderBy: { order: 'asc' },
          }),
        )
      : [];

    const rowsByOrg = new Map<string, ResolvedStage[]>();
    for (const r of stageRows) {
      const list = rowsByOrg.get(r.orgId) ?? [];
      list.push({
        key: r.key,
        label: r.label,
        order: r.order,
        isTerminal: r.isTerminal,
        isOffPath: r.isOffPath,
        color: r.color,
      });
      rowsByOrg.set(r.orgId, list);
    }

    // An org with no PipelineStage rows resolves to the built-in catalogue —
    // the same fallback `resolvePipelineStages` applies, so a single-tenant
    // deployment produces exactly the sets this route hardcoded before.
    const keysByOrg = new Map<string, OutcomeStageKeys>();
    const outcomeFor = (orgKey: string): OutcomeStageKeys => {
      const hit = keysByOrg.get(orgKey);
      if (hit) return hit;
      const rows = rowsByOrg.get(orgKey);
      const stages = rows ? localizeStageLabels(rows, locale) : defaultPipelineStages(locale);
      const resolved = outcomeStageKeysFrom(stages);
      keysByOrg.set(orgKey, resolved);
      return resolved;
    };

    // Fold into per-org totals: total, hired, dropped.
    const byOrg = new Map<string, BenchmarkAgg>();
    for (const g of grouped) {
      // A NULL-org relation is the default org's (the backfill rule), so it is
      // counted as part of that programme, never as an extra anonymous one.
      const key = benchmarkOrgKey(g.orgId, fallbackOrgId);
      const a = byOrg.get(key) ?? { total: 0, hired: 0, dropped: 0 };
      const n = g._count._all;
      // Folded into the default org, a NULL-org row is read against the default
      // org's stage set — the one it is the backfill's row of.
      const outcome = outcomeFor(key);
      a.total += n;
      if (outcome.finished.includes(g.pipelineStatus)) a.hired += n;
      if (outcome.offPath.includes(g.pipelineStatus)) a.dropped += n;
      byOrg.set(key, a);
    }

    // Only the viewer's own stage vocabulary is ever named in the payload.
    const myOutcome = outcomeFor(myOrgId);
    const figures = benchmarkFigures(byOrg, myOrgId);

    return NextResponse.json({
      // Aggregate-only payload — no per-program identities or rows.
      you: figures.you,
      platform: {
        avgConversion: figures.avgConversion,
        avgDropRate: figures.avgDropRate,
        poolSize: figures.poolSize,
        minRelations: MIN_RELATIONS,
        minPrograms: MIN_OTHER_PROGRAMS,
      },
      percentile: figures.percentile,
      // The VIEWER's own finished stage, so the card names what "conversion"
      // counted here (#1882). Never another program's.
      finishedLabel: myOutcome.finishedLabel,
      finishedLabelIsCustom: myOutcome.finishedLabelIsCustom,
    });
  });
}
