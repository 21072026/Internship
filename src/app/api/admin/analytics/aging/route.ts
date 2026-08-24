import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { UNSPECIFIED_REASON } from '@/lib/dropoffReasons';

const DAY = 24 * 60 * 60 * 1000;

// GET — hiring-funnel aging & SLA.
// - stageAging: average/median time actually SPENT in each stage, computed from
//   completed transitions in the StatusChange audit trail (entering a stage →
//   leaving it). This gives meaningful per-stage differences instead of every
//   stage showing the same current-dwell number.
// - oldestStuck / overdue: current dwell in the present stage for ACTIVE
//   relations (how long they've been sitting where they are now).
// - dropReasons (#810): stage × reason breakdown for every move that landed on
//   a negative/off-path stage. "Negative" is resolved from the querying
//   admin's own org pipeline (PipelineStage.isOffPath) — never a hardcoded key
//   list — so a tenant's custom pipeline is honored exactly the same way the
//   board/candidate-detail reason gate honors it. A pre-existing StatusChange
//   with no reasonCode groups under UNSPECIFIED_REASON ("Unspecified" in the UI).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
  // Optional date-range window (?from=YYYY-MM-DD&to=YYYY-MM-DD): only stage
  // transitions that COMPLETED (i.e. the candidate left the stage) within the
  // window feed stageAging. oldestStuck/overdue describe the present, so they
  // are never date-filtered. Bad/inverted dates fall back to "all time".
  const { searchParams } = new URL(request.url);
  const parseDate = (v: string | null): Date | null => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const fromDate = parseDate(searchParams.get('from'));
  const toDate = parseDate(searchParams.get('to'));
  const rangeOk = fromDate && toDate && fromDate.getTime() <= toDate.getTime();
  const inWindow = (leftAt: number) =>
    !rangeOk || (leftAt >= fromDate!.getTime() && leftAt <= toDate!.getTime());

  const now = Date.now();
  const relations = await prisma.mentorshipRelation.findMany({
    select: {
      id: true,
      status: true,
      pipelineStatus: true,
      startDate: true,
      stageDeadline: true,
      mentee: { select: { id: true, fullName: true } },
      statusChanges: {
        orderBy: { createdAt: 'asc' },
        select: { fromStatus: true, toStatus: true, createdAt: true, reasonCode: true },
      },
    },
  });

  const negativeKeys = new Set(
    (await resolvePipelineStages((session.user as { orgId?: string | null }).orgId ?? null))
      .filter((s) => s.isOffPath)
      .map((s) => s.key)
  );
  const dropCounts = new Map<string, Map<string, number>>();
  for (const r of relations) {
    for (const c of r.statusChanges) {
      if (!negativeKeys.has(c.toStatus)) continue;
      const reasonCode = c.reasonCode ?? UNSPECIFIED_REASON;
      if (!dropCounts.has(c.toStatus)) dropCounts.set(c.toStatus, new Map());
      const byReason = dropCounts.get(c.toStatus)!;
      byReason.set(reasonCode, (byReason.get(reasonCode) ?? 0) + 1);
    }
  }
  const dropReasons = Array.from(dropCounts.entries())
    .flatMap(([pipelineStatus, byReason]) =>
      Array.from(byReason.entries()).map(([reasonCode, count]) => ({ pipelineStatus, reasonCode, count }))
    )
    .sort((a, b) => b.count - a.count);

  // Completed durations per stage, from consecutive transitions.
  const byStage = new Map<string, number[]>();
  const pushDuration = (stage: string, ms: number) => {
    if (ms <= 0) return;
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage)!.push(ms / DAY);
  };

  for (const r of relations) {
    const changes = r.statusChanges;
    if (changes.length > 0) {
      // Initial stage: from relation start until the first recorded transition.
      // A stage counts only if it was LEFT within the selected window.
      const firstLeftAt = changes[0].createdAt.getTime();
      if (inWindow(firstLeftAt)) pushDuration(changes[0].fromStatus, firstLeftAt - r.startDate.getTime());
      // Each subsequent stage: entered at changes[i], left at changes[i+1].
      for (let i = 0; i < changes.length - 1; i++) {
        const leftAt = changes[i + 1].createdAt.getTime();
        if (inWindow(leftAt)) pushDuration(changes[i].toStatus, leftAt - changes[i].createdAt.getTime());
      }
    }
  }

  const median = (nums: number[]) => {
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const stageAging = Array.from(byStage.entries())
    .map(([pipelineStatus, days]) => ({
      pipelineStatus,
      count: days.length,
      avgDays: Math.round(days.reduce((s, d) => s + d, 0) / days.length),
      medianDays: Math.round(median(days)),
    }))
    .sort((a, b) => b.avgDays - a.avgDays);

  // Current dwell in the present stage, for active relations only.
  //
  // People in the re-engagement pool (#834) are excluded. They are not stuck —
  // somebody made an explicit "we'll write in September" arrangement with them,
  // and leaving them in `overdue` is precisely what makes this report rot: a
  // list where half the entries will never move stops being read. They are not
  // hidden either; `pooledCount` keeps them visible as their own number.
  const pooledIds = new Set(
    (await prisma.user.findMany({
      where: { id: { in: relations.map((r) => r.mentee.id) }, reEngageAt: { not: null } },
      select: { id: true },
    })).map((u) => u.id)
  );
  const active = relations.filter((r) => r.status === 'ACTIVE' && !pooledIds.has(r.mentee.id));
  const items = active.map((r) => {
    const last = r.statusChanges[r.statusChanges.length - 1];
    const enteredStageAt = last ? last.createdAt : r.startDate;
    return {
      relationId: r.id,
      menteeId: r.mentee.id,
      menteeName: r.mentee.fullName,
      pipelineStatus: r.pipelineStatus,
      daysInStage: Math.floor((now - enteredStageAt.getTime()) / DAY),
      overdue: !!r.stageDeadline && r.stageDeadline.getTime() < now,
    };
  });

  const oldestStuck = [...items].sort((a, b) => b.daysInStage - a.daysInStage).slice(0, 10);
  const overdue = items.filter((it) => it.overdue).sort((a, b) => b.daysInStage - a.daysInStage);

  return NextResponse.json({
    stageAging, oldestStuck, overdue, overdueCount: overdue.length,
    pooledCount: relations.filter((r) => r.status === 'ACTIVE' && pooledIds.has(r.mentee.id)).length,
    dropReasons,
  });
  });
}
