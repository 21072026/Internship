import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

// GET — mentor-scoped analytics: their own pipeline funnel, goal summary and
// engagement stats (EPIC: mentor analytics / pipeline funnel, roadmap #370).
//
// WHAT THE ?from=&to= WINDOW APPLIES TO (#1913, same split as the admin route):
//   Windowed — things that HAPPENED in a period: `interactions`,
//   `goals.done`/`goalsCompletedInRange`, `statusChanges`, and the per-mentee
//   `rows` counts.
//   Present-tense state — where people ARE right now: `funnel`,
//   `totalRelations`, `activeRelations`, `hired`, `conversionToHired`,
//   `avgDaysToHired`. Date-filtering a distribution of current stages would
//   answer a question nobody asked ("who is in stage X *and* started in
//   March"), so it stays unfiltered and the screen says so.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    // A MENTOR sees only their own mentees; an ADMIN sees all (no mentor filter),
    // mirroring the company analytics route.
    const relationWhere = session.user.role === 'ADMIN' ? {} : { mentorId: session.user.id };
    const interactionWhere =
      session.user.role === 'ADMIN' ? {} : { relation: { mentorId: session.user.id } };

    // Same parse-and-fall-back shape as the admin analytics route: a bad or
    // inverted range must report the default window, never a 500 and never an
    // empty period that reads as "you did nothing".
    const { searchParams } = new URL(request.url);
    const now = new Date();
    const parseDate = (v: string | null): Date | null => {
      if (!v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const to = parseDate(searchParams.get('to')) ?? now;
    const defaultFrom = new Date(to.getFullYear(), to.getMonth() - 5, 1);
    let from = parseDate(searchParams.get('from')) ?? defaultFrom;
    if (from.getTime() > to.getTime()) from = defaultFrom;
    const inRange = { gte: from, lte: to };

    const [relations, interactionsByRelation, goals] = await Promise.all([
      prisma.mentorshipRelation.findMany({
        where: relationWhere,
        select: {
          id: true,
          status: true,
          pipelineStatus: true,
          startDate: true,
          mentee: { select: { id: true, fullName: true } },
          statusChanges: { orderBy: { createdAt: 'asc' }, select: { toStatus: true, createdAt: true } },
        },
      }),
      // Grouped rather than counted: the same query feeds both the headline
      // number and the per-mentee export row, so the two can never disagree.
      prisma.interactionLog.groupBy({
        by: ['relationId'],
        where: { ...interactionWhere, date: inRange },
        _count: { _all: true },
      }),
      prisma.goal.findMany({
        where: interactionWhere,
        select: { relationId: true, status: true, completedAt: true },
      }),
    ]);

    const interactionsPerRelation = new Map(
      interactionsByRelation.map((g) => [g.relationId, g._count._all])
    );
    const interactions = interactionsByRelation.reduce((n, g) => n + g._count._all, 0);

    // Pipeline funnel: count mentees per stage (all relations, not just active).
    const funnel: Record<string, number> = {};
    for (const r of relations) {
      funnel[r.pipelineStatus] = (funnel[r.pipelineStatus] ?? 0) + 1;
    }

    const totalRelations = relations.length;
    const activeRelations = relations.filter((r) => r.status === 'ACTIVE').length;
    const hired = relations.filter(
      (r) => r.pipelineStatus === 'HIRED_660' || r.pipelineStatus === 'EMPLOYED_700'
    ).length;
    const conversionToHired = totalRelations > 0 ? Math.round((hired / totalRelations) * 100) : 0;

    // Goal summary across all mentees. OPEN/total are current state; "done" is
    // an event, so it is also reported for the window.
    const goalsOpen = goals.filter((g) => g.status === 'OPEN').length;
    const goalsDone = goals.filter((g) => g.status === 'DONE').length;
    const goalsTotal = goals.length;
    const isDoneInRange = (g: { status: string; completedAt: Date | null }) =>
      g.status === 'DONE' &&
      g.completedAt != null &&
      g.completedAt >= from &&
      g.completedAt <= to;
    const goalsDoneInRange = goals.filter(isDoneInRange).length;
    const goalsDonePerRelation = new Map<string, number>();
    for (const g of goals) {
      if (!isDoneInRange(g)) continue;
      goalsDonePerRelation.set(g.relationId, (goalsDonePerRelation.get(g.relationId) ?? 0) + 1);
    }

    // Stage moves inside the window: the one engagement signal that shows a
    // mentee actually progressed rather than merely being talked to.
    const statusChanges = relations.reduce(
      (n, r) => n + r.statusChanges.filter((c) => c.createdAt >= from && c.createdAt <= to).length,
      0
    );

    // Average days to hired for completed mentees.
    let avgDaysToHired: number | null = null;
    const hiredRelations = relations.filter(
      (r) => r.pipelineStatus === 'HIRED_660' || r.pipelineStatus === 'EMPLOYED_700'
    );
    if (hiredRelations.length > 0) {
      const durations = hiredRelations
        .map((r) => {
          const last = r.statusChanges[r.statusChanges.length - 1];
          if (!last) return null;
          return Math.floor((last.createdAt.getTime() - r.startDate.getTime()) / (24 * 60 * 60 * 1000));
        })
        // Backdated status changes can put the HIRED/EMPLOYED transition before
        // the relation's startDate, producing a negative duration — drop it
        // rather than average in a nonsensical value.
        .filter((d): d is number => d !== null && d >= 0);
      if (durations.length > 0) {
        avgDaysToHired = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
      }
    }

    // Per-mentee rows: what the export writes, computed server-side so the
    // spreadsheet and the screen are the same numbers. Days in stage is the
    // same formula as the admin aging report — since the last recorded move,
    // else since the relation started.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const rows = relations.map((r) => {
      const last = r.statusChanges[r.statusChanges.length - 1];
      const enteredStageAt = last ? last.createdAt : r.startDate;
      return {
        menteeId: r.mentee.id,
        menteeName: r.mentee.fullName,
        pipelineStatus: r.pipelineStatus,
        daysInStage: Math.max(0, Math.floor((now.getTime() - enteredStageAt.getTime()) / DAY_MS)),
        interactions: interactionsPerRelation.get(r.id) ?? 0,
        goalsDone: goalsDonePerRelation.get(r.id) ?? 0,
      };
    });

    const iso = (d: Date) => d.toISOString().slice(0, 10);

    return NextResponse.json({
      funnel,
      totalRelations,
      activeRelations,
      hired,
      conversionToHired,
      interactions,
      goals: { open: goalsOpen, done: goalsDone, total: goalsTotal, doneInRange: goalsDoneInRange },
      avgDaysToHired,
      statusChanges,
      rows,
      // Echoed so the screen can say which period these numbers describe — and
      // so a caller that sent a bad range sees what it actually got.
      range: { from: iso(from), to: iso(to) },
    });
  });
}
