import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';
import { runUnscoped } from '@/lib/tenantAmbient';
import { outcomeStageKeysFrom, type OutcomeStageKeys } from '@/lib/pipelineStages';
import { defaultPipelineStages, localizeStageLabels, type ResolvedStage } from '@/lib/pipeline';
import { getLocale } from '@/i18n/server';

// Minimum relations for a program (org) to enter the benchmark pool. This is a
// k-anonymity floor: tiny programs are excluded so an aggregate can't be
// reverse-engineered to an individual, and so noisy small samples don't skew
// the average.
const MIN_RELATIONS = 5;

// GET — premium cross-program benchmark (Faz 2, #542). Compares the viewer's
// organization's funnel conversion against an ANONYMIZED, aggregated average
// across all qualifying programs. Only aggregate numbers cross the boundary —
// never another program's identity or raw rows. Gated by premiumAnalytics.
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
  if ((await getSetting('premiumAnalytics')) !== 'true') {
    return NextResponse.json({ error: 'feature_locked' }, { status: 403 });
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
    const grouped = await prisma.mentorshipRelation.groupBy({
      by: ['orgId', 'pipelineStatus'],
      _count: { _all: true },
    });

    const myOrgId = resolveOrgId(session);

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
    type Agg = { total: number; hired: number; dropped: number };
    const byOrg = new Map<string, Agg>();
    for (const g of grouped) {
      const key = g.orgId ?? '__none__';
      const a = byOrg.get(key) ?? { total: 0, hired: 0, dropped: 0 };
      const n = g._count._all;
      // `__none__` (a relation with no org at all) has no stage rows to read,
      // so `outcomeFor` hands it the built-in catalogue — which is what it was
      // counted against before.
      const outcome = outcomeFor(key);
      a.total += n;
      if (outcome.finished.includes(g.pipelineStatus)) a.hired += n;
      if (outcome.offPath.includes(g.pipelineStatus)) a.dropped += n;
      byOrg.set(key, a);
    }

    const conv = (a: Agg) => (a.total > 0 ? Math.round((a.hired / a.total) * 100) : 0);
    const dropRate = (a: Agg) => (a.total > 0 ? Math.round((a.dropped / a.total) * 100) : 0);

    // The viewer's own program.
    const mine = (myOrgId && byOrg.get(myOrgId)) || null;
    // Only the viewer's own stage vocabulary is ever named in the payload.
    const myOutcome = outcomeFor(myOrgId ?? '__none__');

    // Benchmark pool: every program meeting the k-anonymity floor.
    const pool = [...byOrg.values()].filter((a) => a.total >= MIN_RELATIONS);
    const poolSize = pool.length;

    const avg = (fn: (a: Agg) => number) =>
      poolSize > 0 ? Math.round(pool.reduce((s, a) => s + fn(a), 0) / poolSize) : null;

    const platformAvgConversion = avg(conv);
    const platformAvgDropRate = avg(dropRate);

    // The viewer's percentile within the pool (share of programs at or below your
    // conversion), only when the pool is large enough to be non-identifying.
    let percentile: number | null = null;
    if (mine && poolSize >= 3) {
      const myConv = conv(mine);
      const atOrBelow = pool.filter((a) => conv(a) <= myConv).length;
      percentile = Math.round((atOrBelow / poolSize) * 100);
    }

    return NextResponse.json({
      // Aggregate-only payload — no per-program identities or rows.
      you: mine
        ? { conversion: conv(mine), dropRate: dropRate(mine), total: mine.total, hired: mine.hired }
        : null,
      platform: {
        avgConversion: platformAvgConversion,
        avgDropRate: platformAvgDropRate,
        poolSize,
        minRelations: MIN_RELATIONS,
      },
      percentile,
      // The VIEWER's own finished stage, so the card names what "conversion"
      // counted here (#1882). Never another program's.
      finishedLabel: myOutcome.finishedLabel,
      finishedLabelIsCustom: myOutcome.finishedLabelIsCustom,
    });
  });
}
