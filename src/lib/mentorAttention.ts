import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { findDormantFirstContacts } from '@/lib/dormantFirstContact';
import { getLastContacts } from '@/lib/lastContact';
import { getSetting } from '@/lib/settings';
import { addUtcWeeks, firstFullUtcWeek, utcWeekStart } from '@/lib/week';
import { SUBMITTED_WEEKLY_REPORT_STATUSES } from '@/lib/weeklyReports';
import { TRIAL_EXPIRED_STAGE_KEY } from '@/lib/programTemplates';
import { isTrialMissingEndDate } from '@/lib/trialReminderRule';
import { isNextActionOverdue } from '@/lib/nextActionRule';

export type AttentionReason = 'inactive' | 'overdue' | 'unanswered_question' | 'pending_meeting' | 'no_open_goal' | 'missing_weekly_reports' | 'trial_expired' | 'trial_no_end_date' | 'next_action_due';

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
// agree on what "stale" means, and the same definition of *contact* as both
// (lib/lastContact.ts): in-app messaging counts, so a mentor mid-conversation
// with a mentee is never told they have not been in touch.
//
// `options` exists for the MARKETING sales surface (#2580) and changes nothing
// when omitted — the mentor dashboard calls this with one argument and gets the
// exact query and list it always got:
//   - `reasons` keeps only those reasons (a record left with none drops out),
//     because most reasons here are mentorship work a sales record never has;
//   - `relationWhere` is ANDed onto the owner filter, so a caller can add the
//     tenant filter (tenantWhere/withinTenant) this function does not know about.
export async function getAttentionItems(
  mentorId: string,
  options: {
    reasons?: readonly AttentionReason[];
    relationWhere?: Prisma.MentorshipRelationWhereInput;
  } = {},
): Promise<AttentionQueue> {
  const reminderDays = parseInt(await getSetting('reminderDays'), 10) || 14;
  const now = Date.now();
  const staleCutoff = new Date(now - reminderDays * 24 * 60 * 60 * 1000);
  const ownerWhere: Prisma.MentorshipRelationWhereInput = { mentorId, status: 'ACTIVE' };

  const relations = await prisma.mentorshipRelation.findMany({
    where: options.relationWhere ? { AND: [ownerWhere, options.relationWhere] } : ownerWhere,
    select: {
      id: true,
      orgId: true,
      pipelineStatus: true,
      startDate: true,
      stageDeadline: true,
      nextActionAt: true,
      trialEndsAt: true,
      mentee: { select: { id: true, fullName: true } },
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
    })),
  );

  const lastContacts = await getLastContacts(
    relations.map((r) => ({ id: r.id, menteeId: r.mentee.id })),
  );

  const items: AttentionItem[] = [];
  let dormantCount = 0;
  for (const r of relations) {
    if (dormant.has(r.id)) {
      dormantCount += 1;
      continue;
    }
    const reasons: AttentionReason[] = [];
    const last = lastContacts.get(r.id)?.at ?? null;
    const daysSince = last ? Math.floor((now - last.getTime()) / (24 * 60 * 60 * 1000)) : null;

    if (!last || last < staleCutoff) reasons.push('inactive');
    if (r.stageDeadline && r.stageDeadline.getTime() < now) reasons.push('overdue');
    if (r.questions.length > 0) reasons.push('unanswered_question');
    if (r.meetingRequests.length > 0) reasons.push('pending_meeting');
    if (r.goals.length === 0 && !hasOpenTodo.has(r.mentee.id)) reasons.push('no_open_goal');
    // A trial that has run out (#2418). The sweep in lib/jobs/trialReminders.ts
    // parks the record in TRIAL_EXPIRED and then stops: nothing else happens to
    // it until a human turns it into a proposal or a loss, so it belongs in the
    // queue its owner already reads rather than on a new board card. The key
    // comes from the preset that ships it (lib/programTemplates.ts), never
    // written as a literal here; a tenant that renamed the LABEL keeps the key,
    // and a tenant without the stage simply has no relation sitting in it.
    //
    // No "how long has it been waiting" is computed here on purpose:
    // lib/stageClock.ts owns time-in-stage and the board already shows it. This
    // branch answers only "is this one waiting for a decision?".
    //
    // Know what that board number currently says for an AUTOMATICALLY expired
    // trial, though: the sweep writes an `AuditLog` row and no `StatusChange`
    // (it has no `User` to put in the required FK), and `StatusChange` is the
    // only thing the stage clock reads — so such a record shows the age of the
    // whole trial rather than the age of the decision. #2527 fixes that at the
    // source; nothing here should paper over it with a second calculation.
    if (r.pipelineStatus === TRIAL_EXPIRED_STAGE_KEY) reasons.push('trial_expired');
    // A running trial with no end date (#2553) is invisible to the reminder
    // ladder and the expiry sweep alike — nothing would ever happen to it. It
    // sits here until the owner enters the date, and leaves on that write.
    if (isTrialMissingEndDate(r)) reasons.push('trial_no_end_date');
    // The follow-up date the owner wrote on the record has passed (#2563).
    // The day ITSELF is the reminder's (checkNextActionReminders); the record
    // lands here from the next day on, and leaves the moment the date is moved
    // or cleared. Independent of `overdue` above, which is the stage SLA.
    if (isNextActionOverdue(r.nextActionAt, now)) reasons.push('next_action_due');
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

    const kept = options.reasons ? reasons.filter((reason) => options.reasons!.includes(reason)) : reasons;
    if (kept.length > 0) {
      items.push({
        relationId: r.id,
        menteeId: r.mentee.id,
        menteeName: r.mentee.fullName,
        reasons: kept,
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
