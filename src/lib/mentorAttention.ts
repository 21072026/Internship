import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { findDormantFirstContacts } from '@/lib/dormantFirstContact';
import { getLastContacts } from '@/lib/lastContact';
import { getSetting } from '@/lib/settings';
import { SUBMITTED_WEEKLY_REPORT_STATUSES } from '@/lib/weeklyReports';
import { scoreRelation } from '@/lib/relationHealth';
import { menteesWithOpenTodo } from '@/lib/openWork';
import { TRIAL_EXPIRED_STAGE_KEY } from '@/lib/programTemplates';
import { isTrialMissingEndDate } from '@/lib/trialReminderRule';
import { isNextActionOverdue } from '@/lib/nextActionRule';
import { usageSignalsFor, type UsageNote } from '@/lib/usageSignals';

export type AttentionReason = 'inactive' | 'overdue' | 'unanswered_question' | 'pending_meeting' | 'no_open_goal' | 'missing_weekly_reports' | 'trial_expired' | 'trial_no_end_date' | 'next_action_due' | 'evaluation_due' | 'usage_drop' | 'trial_inactive';

// The relationship-health flags this queue shows (#1898) — every one the
// table raises except `stage_stalled`, which belongs to the admin monitor.
const QUEUE_HEALTH_REASONS = ['inactive', 'overdue', 'unanswered_question', 'pending_meeting', 'no_open_goal', 'missing_weekly_reports'] as const;

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
  /**
   * The usage signals' footnote (#2449): whether a usage feed exists for the
   * org at all, how many of the caller's accounts were left out for too short
   * a history, and how many dropping accounts nobody actively owns. Null when
   * the caller passed no `orgId` or the reasons filter excludes both signals.
   */
  usage: UsageNote | null;
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
    // Whose `reminderDays` decides "no recent contact" (#2628). The dashboards
    // calling this render outside any tenant scope, so without it the read is
    // the global row rather than the viewer's own org's setting.
    orgId?: string;
  } = {},
): Promise<AttentionQueue> {
  const reminderDays = parseInt(await getSetting('reminderDays', options.orgId), 10) || 14;
  const now = Date.now();
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
      trialStartedAt: true,
      companyId: true,
      mentee: { select: { id: true, fullName: true } },
      questions: { where: { answer: null }, select: { id: true } },
      meetingRequests: { where: { status: 'PENDING' }, select: { id: true } },
      goals: { where: { status: 'OPEN' }, select: { id: true } },
      weeklyReports: { where: { status: { in: [...SUBMITTED_WEEKLY_REPORT_STATUSES] } }, select: { weekStart: true } },
      // An INTERIM/FINAL evaluation past its due date and not yet written (#1891).
      evaluationDues: { where: { completedAt: null, dueAt: { lte: new Date(now) } }, select: { id: true } },
    },
  });

  // "Nothing open" counts to-dos as well as goals (#1113) — the rule lives in
  // lib/openWork.ts, shared with the nightly health sweep (#1901).
  const hasOpenTodo = await menteesWithOpenTodo(relations.map((r) => r.mentee.id));

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

  // Product-usage signals (#2449): only show, never move a stage. Computed only
  // when the caller names the org and asked for at least one of the two.
  const wantsUsage = !options.reasons || options.reasons.some((r) => r === 'usage_drop' || r === 'trial_inactive');
  const usage = options.orgId && wantsUsage && relations.length > 0
    ? await usageSignalsFor(options.orgId, relations, new Date(now))
    : null;

  const items: AttentionItem[] = [];
  let dormantCount = 0;
  for (const r of relations) {
    if (dormant.has(r.id)) {
      dormantCount += 1;
      continue;
    }
    const last = lastContacts.get(r.id)?.at ?? null;
    const daysSince = last ? Math.floor((now - last.getTime()) / (24 * 60 * 60 * 1000)) : null;

    // The mentorship reasons come from the relationship-health rules table
    // (#1898, src/lib/relationHealth.ts), so this queue and the admin health
    // monitor can never disagree about what is wrong with a pair. The table's
    // flags carry exactly this queue's semantics; its score is not used here.
    // Stage movement is the monitor's concern, not this queue's: it is not
    // loaded, and its flag is dropped by the filter below.
    const health = scoreRelation({
      now,
      reminderDays,
      status: 'ACTIVE',
      dormant: false,
      startDate: r.startDate,
      lastContactAt: last,
      stageDeadline: r.stageDeadline,
      unansweredQuestions: r.questions.length,
      pendingMeetingRequests: r.meetingRequests.length,
      hasOpenWork: r.goals.length > 0 || hasOpenTodo.has(r.mentee.id),
      weeklyReports:
        r.pipelineStatus === 'INTERNSHIP_IN_PROGRESS_450'
          ? { submittedWeekStarts: r.weeklyReports.map((report) => report.weekStart.getTime()) }
          : null,
      lastStageMoveAt: null,
    });
    const reasons: AttentionReason[] = health.excluded
      ? []
      : health.reasons.filter((reason): reason is (typeof QUEUE_HEALTH_REASONS)[number] => (QUEUE_HEALTH_REASONS as readonly string[]).includes(reason));

    // A trial that has run out (#2418). The sweep in lib/jobs/trialReminders.ts
    // parks the record in TRIAL_EXPIRED and then stops: nothing else happens to
    // it until a human closes it as won or lost (#2572 — there is no proposal
    // stage in between), so it belongs in the queue its owner already reads
    // rather than on a new board card. The key
    // comes from the preset that ships it (lib/programTemplates.ts), never
    // written as a literal here; a tenant that renamed the LABEL keeps the key,
    // and a tenant without the stage simply has no relation sitting in it.
    //
    // No "how long has it been waiting" is computed here on purpose:
    // lib/stageClock.ts owns time-in-stage and the board already shows it. This
    // branch answers only "is this one waiting for a decision?".
    //
    // That board number is right for an AUTOMATICALLY expired trial too: since
    // #2527 the sweep writes the move as a `StatusChange` with `changedById:
    // null` (the system actor) in the same transaction, and `StatusChange` is
    // what the stage clock reads — so the record shows the age of the decision,
    // not of the whole trial. Nothing here computes a second number.
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
    // An evaluation the programme's schedule says is due (#1891) — the same
    // EvaluationDue row the reminders read, so the in-app nudge and the mail
    // agree, and it leaves the queue the moment the evaluation is written.
    if (r.evaluationDues.length > 0) reasons.push('evaluation_due');
    for (const reason of usage?.reasons.get(r.id) ?? []) reasons.push(reason);
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

  return { items, dormantCount, usage: usage?.note ?? null };
}
