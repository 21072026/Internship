import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const DAY = 24 * 60 * 60 * 1000;

// GET — hiring-funnel aging & SLA.
// - stageAging: average/median time actually SPENT in each stage, computed from
//   completed transitions in the StatusChange audit trail (entering a stage →
//   leaving it). This gives meaningful per-stage differences instead of every
//   stage showing the same current-dwell number.
// - oldestStuck / overdue: current dwell in the present stage for ACTIVE
//   relations (how long they've been sitting where they are now).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
        select: { fromStatus: true, toStatus: true, createdAt: true },
      },
    },
  });

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
      pushDuration(changes[0].fromStatus, changes[0].createdAt.getTime() - r.startDate.getTime());
      // Each subsequent stage: entered at changes[i], left at changes[i+1].
      for (let i = 0; i < changes.length - 1; i++) {
        pushDuration(changes[i].toStatus, changes[i + 1].createdAt.getTime() - changes[i].createdAt.getTime());
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
  const active = relations.filter((r) => r.status === 'ACTIVE');
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

  return NextResponse.json({ stageAging, oldestStuck, overdue, overdueCount: overdue.length });
}
