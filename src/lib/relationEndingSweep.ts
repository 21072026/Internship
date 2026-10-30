// The ending-soon sweep (#1786) — the one writer of `endingSoonNotifiedAt`.
// Server-only; runs as the daily `reminders.relationEnding` job (09:00, with
// the morning batch, src/jobs/reminders.ts). The rule — who is due, and the two
// limits (ONE nudge per end date, never an automatic closure or extension) — is
// src/lib/relationEnding.ts.
//
// Who: live, NOT paused pairings (`activeRelationWhere()`, #1772) with an
// agreed end date inside their programme's `relationEndingLeadDays` window and
// no stamp yet. Each is CLAIMED by one guarded update (stamp still null, end
// date unchanged) before anyone is told, so two replicas or a retried job never
// nudge twice; the mail additionally carries a dedupe key per recipient and end
// date. Both participants get an in-app notice and a mail in their own
// language; the mentor's carries the signed one-click extend link.
//
// Rerun-safe: a claimed pairing is skipped on the next run, and a pairing
// whose date moves (an extension, an edit) is unstamped by the writer that
// moved it — so the NEW date gets its own single nudge.

import { prisma } from '@/lib/prisma';
import { emit } from '@/lib/events/emit';
import { notifyIfAllowed } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { logger } from '@/lib/logger';
import { resolveSetting } from '@/lib/settingsResolver';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import { activeRelationWhere } from '@/lib/relationLifecycle';
import { endingLeadDays, isEndingSoon, MAX_ENDING_LEAD_DAYS, originalDurationMonths } from '@/lib/relationEnding';
import { sendRelationEndingEmail } from '@/services/emailService';
import { isBenched } from '@/lib/participantState';

const DAY_MS = 24 * 60 * 60 * 1000;

const PERSON = {
  id: true,
  fullName: true,
  email: true,
  orgId: true,
  isActive: true,
  participantState: true,
  preferredLanguage: true,
  emailNotifications: true,
  notificationPrefs: true,
} as const;

export async function sweepEndingSoonRelations(now: Date = new Date()): Promise<{ checked: number; notified: number }> {
  const candidates = await prisma.mentorshipRelation.findMany({
    where: {
      ...activeRelationWhere(),
      endingSoonNotifiedAt: null,
      expectedEndDate: { gt: new Date(now.getTime() - DAY_MS), lte: new Date(now.getTime() + MAX_ENDING_LEAD_DAYS * DAY_MS) },
    },
    select: {
      id: true,
      orgId: true,
      cohortId: true,
      startDate: true,
      expectedEndDate: true,
      endingSoonNotifiedAt: true,
      mentor: { select: PERSON },
      mentee: { select: PERSON },
    },
    orderBy: { expectedEndDate: 'asc' },
    take: 500,
  });

  // The lead per programme (programme → org → global), read once per scope.
  const leads = new Map<string, Promise<number>>();
  const leadFor = (orgId: string | null, cohortId: string | null) => {
    const key = `${orgId ?? ''}|${cohortId ?? ''}`;
    let lead = leads.get(key);
    if (!lead) {
      lead = settingsOrgOfRow(orgId).then(async (org) => endingLeadDays(await resolveSetting('relationEndingLeadDays', { orgId: org, programId: cohortId })));
      leads.set(key, lead);
    }
    return lead;
  };

  let notified = 0;
  for (const r of candidates) {
    if (!isEndingSoon(r, now, await leadFor(r.orgId, r.cohortId))) continue;
    const claim = await prisma.mentorshipRelation.updateMany({
      where: { id: r.id, endingSoonNotifiedAt: null, expectedEndDate: r.expectedEndDate },
      data: { endingSoonNotifiedAt: now },
    });
    if (claim.count !== 1) continue;
    notified += 1;
    const endDay = r.expectedEndDate!.toISOString().slice(0, 10);

    await emit('mentorship.ending_soon', { relationId: r.id, expectedEndDate: endDay }, { orgId: r.orgId, actor: { id: null, type: 'system' } });

    const sides = [
      { me: r.mentor, other: r.mentee, link: `/mentor/mentees/${r.id}`, extend: { months: originalDurationMonths(r.startDate, r.expectedEndDate!) } },
      { me: r.mentee, other: r.mentor, link: '/portal/calendar', extend: null },
    ];
    for (const side of sides) {
      // Inactive or benched (#1778): nobody on the bench is nudged.
      if (!side.me.isActive || isBenched(side.me)) continue;
      await notifyIfAllowed(side.me.id, 'mentorship', 'mentorship.ending_soon', { name: side.other.fullName, date: endDay }, side.link);
      if (side.me.email && emailAllowed(side.me, 'mentorship') && emailGroupAllowedForCategory(side.me, 'relation-ending')) {
        await sendRelationEndingEmail({
          to: side.me.email,
          userId: side.me.id,
          orgId: side.me.orgId,
          locale: side.me.preferredLanguage,
          recipientName: side.me.fullName,
          otherName: side.other.fullName,
          relationId: r.id,
          endDay,
          bookPath: side.link,
          extend: side.extend,
        }).catch((e) => logger.error('relation_ending.mail_failed', { relationId: r.id, error: e instanceof Error ? e.name : 'unknown' }));
      }
    }
  }
  return { checked: candidates.length, notified };
}
