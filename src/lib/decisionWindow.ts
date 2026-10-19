import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { notifyIfAllowed } from '@/lib/notify';
import { notificationLink, type NotificationRole } from '@/lib/notificationLink';
import { shellCapabilities } from '@/lib/shellCapabilities';
import {
  DECISION_WINDOW_CLAIM,
  TRIAL_EXPIRED_STAGE_KEY,
  decisionWindowEndsAt,
  isDecisionWindowBellDue,
} from '@/lib/trialReminderRule';
import { decisionWindowDaysFor } from '@/lib/trialWindow';

// The "decision window closing" bell (#2843); the rule is in
// src/lib/trialReminderRule.ts. Run from the daily trial sweep, per MARKETING
// org, with that org's window length (`decisionWindowDays`, #2927). One bell
// per record: the claim is a TrialReminder row at the negative threshold
// DECISION_WINDOW_CLAIM — the same unique (relationId, threshold) that keeps
// the trial ladder from ringing twice. Never moves a stage, and never rings
// for a window that closed more than DECISION_WINDOW_STALE_DAYS ago.

export async function ringDecisionWindows(orgId: string, now: Date): Promise<number> {
  const windowDays = await decisionWindowDaysFor(orgId);
  const candidates = await prisma.mentorshipRelation.findMany({
    where: {
      orgId,
      status: 'ACTIVE',
      pipelineStatus: TRIAL_EXPIRED_STAGE_KEY,
      trialEndsAt: { not: null },
      trialReminders: { none: { threshold: DECISION_WINDOW_CLAIM } },
    },
    select: {
      id: true,
      menteeId: true,
      mentorId: true,
      pipelineStatus: true,
      trialEndsAt: true,
      company: { select: { name: true } },
      mentee: { select: { fullName: true } },
      mentor: { select: { role: true } },
    },
  });
  // Not a window that closed more than DECISION_WINDOW_STALE_DAYS ago (#2970):
  // a historic or late-loaded record must not ring a stale reminder. It stays
  // in the owner's queue; it simply never rings.
  const due = candidates.filter((r) => isDecisionWindowBellDue(r, now, windowDays));
  if (due.length === 0) return 0;
  const capabilities = await shellCapabilities(orgId);
  let rung = 0;
  for (const r of due) {
    try {
      await prisma.trialReminder.create({ data: { orgId, relationId: r.id, threshold: DECISION_WINDOW_CLAIM } });
    } catch (e) {
      // Claimed by an overlapping tick.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
      throw e;
    }
    const closes = decisionWindowEndsAt(r.trialEndsAt, windowDays)!;
    const link = notificationLink(r.mentor.role as NotificationRole, 'relation', { relationId: r.id, menteeId: r.menteeId }, { capabilities });
    await notifyIfAllowed(
      r.mentorId,
      'deadlines',
      'trial.decisionWindowClosing',
      { company: r.company?.name ?? r.mentee.fullName, date: closes.toISOString().slice(0, 10) },
      link,
    );
    rung += 1;
  }
  return rung;
}
