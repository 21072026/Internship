import { prisma } from '@/lib/prisma';
import { findDormantFirstContacts } from '@/lib/dormantFirstContact';
import { getSetting } from '@/lib/settings';
import { addUtcWeeks, firstFullUtcWeek, utcWeekStart } from '@/lib/week';
import { SUBMITTED_WEEKLY_REPORT_STATUSES } from '@/lib/weeklyReports';

export type AttentionReason = 'inactive' | 'overdue' | 'unanswered_question' | 'pending_meeting' | 'no_open_goal' | 'missing_weekly_reports';

export interface AttentionItem {
  relationId: string;
  menteeId: string;
  menteeName: string;
  reasons: AttentionReason[];
  daysSinceLastInteraction: number | null;
}

export interface AttentionQueue {
  items: AttentionItem[];
  /**
   * How many relations were left out because they are dormant first contacts
   * (see lib/dormantFirstContact.ts) — surfaced as a footnote so a filtered
   * queue never looks like a broken one.
   */
  dormantCount: number;
}

// A ranked "needs attention" list for a mentor's active mentees (EPIC: mentor
// attention queue). Reuses the same inactivity threshold as the weekly email
// digest (Setting.reminderDays, default 14) so the in-app view and the email
// agree on what "stale" means.
export async function getAttentionItems(mentorId: string): Promise<AttentionQueue> {
  const reminderDays = parseInt(await getSetting('reminderDays'), 10) || 14;
  const now = Date.now();
  const staleCutoff = new Date(now - reminderDays * 24 * 60 * 60 * 1000);

  const relations = await prisma.mentorshipRelation.findMany({
    where: { mentorId, status: 'ACTIVE' },
    select: {
      id: true,
      orgId: true,
      pipelineStatus: true,
      startDate: true,
      stageDeadline: true,
      mentee: { select: { id: true, fullName: true } },
      interactions: { orderBy: { date: 'desc' }, take: 1, select: { date: true } },
      questions: { where: { answer: null }, select: { id: true } },
      meetingRequests: { where: { status: 'PENDING' }, select: { id: true } },
      goals: { where: { status: 'OPEN' }, select: { id: true } },
      weeklyReports: { where: { status: { in: [...SUBMITTED_WEEKLY_REPORT_STATUSES] } }, select: { weekStart: true } },
    },
  });

  // "Nothing open" is not a goals-only question (#1113 to-dos): a mentor hands
  // work out from the shared pool as ProjectTasks, not as Goal rows, so a mentee
  // with four open to-dos and no Goal was still flagged "no open goal". Count the
  // to-dos the mentor can actually see on that mentee's list — the ones a project
  // or another person put there, which is exactly the filter
  // GET /api/todos applies when reading somebody else's list; a line the mentee
  // wrote for themselves is private and stays out of this.
  const menteeIds = relations.map((r) => r.mentee.id);
  const openTodos = menteeIds.length
    ? await prisma.projectTask.findMany({
        where: {
          assigneeId: { in: menteeIds },
          done: false,
          archivedAt: null,
        },
        select: { assigneeId: true, projectId: true, createdById: true },
      })
    : [];
  const hasOpenTodo = new Set(
    openTodos
      .filter((t) => t.projectId !== null || t.createdById !== t.assigneeId)
      .map((t) => t.assigneeId as string)
  );

  // Applicants who never came back after the first outreach are not work the
  // mentor can do anything about — they'd otherwise fill the queue permanently
  // with "no recent contact" + "no open goal" (#1499).
  const dormant = await findDormantFirstContacts(
    relations.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      menteeId: r.mentee.id,
      pipelineStatus: r.pipelineStatus,
      stageDeadline: r.stageDeadline,
      lastInteractionAt: r.interactions[0]?.date ?? null,
    })),
  );

  const items: AttentionItem[] = [];
  let dormantCount = 0;
  for (const r of relations) {
    if (dormant.has(r.id)) {
      dormantCount += 1;
      continue;
    }
    const reasons: AttentionReason[] = [];
    const last = r.interactions[0]?.date ?? null;
    const daysSince = last ? Math.floor((now - last.getTime()) / (24 * 60 * 60 * 1000)) : null;

    if (!last || last < staleCutoff) reasons.push('inactive');
    if (r.stageDeadline && r.stageDeadline.getTime() < now) reasons.push('overdue');
    if (r.questions.length > 0) reasons.push('unanswered_question');
    if (r.meetingRequests.length > 0) reasons.push('pending_meeting');
    if (r.goals.length === 0 && !hasOpenTodo.has(r.mentee.id)) reasons.push('no_open_goal');
    if (r.pipelineStatus === 'INTERNSHIP_IN_PROGRESS_450') {
      const currentWeek = utcWeekStart(new Date(now));
      const firstEligibleWeek = firstFullUtcWeek(r.startDate);
      const lastWeek = addUtcWeeks(currentWeek, -1);
      const previousWeek = addUtcWeeks(currentWeek, -2);
      const submitted = new Set(r.weeklyReports.map((report) => report.weekStart.getTime()));
      if (previousWeek >= firstEligibleWeek && !submitted.has(lastWeek.getTime()) && !submitted.has(previousWeek.getTime())) {
        reasons.push('missing_weekly_reports');
      }
    }

    if (reasons.length > 0) {
      items.push({
        relationId: r.id,
        menteeId: r.mentee.id,
        menteeName: r.mentee.fullName,
        reasons,
        daysSinceLastInteraction: daysSince,
      });
    }
  }

  // Most reasons first, then longest-inactive first.
  items.sort((a, b) => {
    if (b.reasons.length !== a.reasons.length) return b.reasons.length - a.reasons.length;
    return (b.daysSinceLastInteraction ?? Infinity) - (a.daysSinceLastInteraction ?? Infinity);
  });

  return { items, dormantCount };
}
