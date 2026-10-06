// A survey's completion (#1889): who still owes an answer — never what anyone
// said. The coordinator's question, answered without touching a response row.
//
//   • ANONYMOUS: counts and reminder state only. There is no per-person list in
//     the payload at all — "who answered" next to the response timestamps is
//     exactly the link the anonymous promise says does not exist.
//   • IDENTIFIED / CONFIDENTIAL: the people who have NOT answered, with their
//     reminder state. Who did answer is not listed either; the console's job
//     is the next nudge.
//   • The response rate is answered/invited, and below the survey's floor it is
//     not shown at all: 2 of 30 is noise, not a rate a sponsor should be read.
//
// Admin-only, enforced by the route. docs/surveys.md § Reminders and completion.

import { prisma } from '@/lib/prisma';
import { effectiveMinResponses } from '@/lib/surveyPrivacy';
import { pickLocalized } from '@/lib/surveySchema';
import { REMINDER_SELECT, reminderRefusal, SURVEY_MAX_REMINDERS } from '@/lib/surveyReminders';

export interface PendingRecipient {
  invitationId: string;
  name: string | null;
  email: string;
  remindersSent: number;
  lastRemindedAt: Date | null;
  expiresAt: Date;
  /** Null when "remind now" would send; otherwise why it would not. */
  cannotRemind: string | null;
}

export interface SurveyCompletion {
  survey: { id: string; title: string; anonymity: string; status: string };
  floor: number;
  invited: number;
  /** Null below the floor (see header). */
  responded: number | null;
  rate: number | null;
  maxReminders: number;
  /** Unanswered invitations by how many reminders they have had: index = count. */
  pendingByReminders: number[];
  /** Absent (null) for an ANONYMOUS survey — not merely hidden by the screen. */
  pending: PendingRecipient[] | null;
}

export async function loadSurveyCompletion(surveyId: string, locale: string, now = new Date()): Promise<SurveyCompletion | null> {
  const survey = await prisma.survey.findUnique({
    where: { id: surveyId },
    select: { id: true, title: true, anonymity: true, status: true, opensAt: true, closesAt: true, minResponses: true },
  });
  if (!survey) return null;
  const floor = effectiveMinResponses(survey.minResponses);
  const anonymous = survey.anonymity === 'ANONYMOUS';

  const [invited, responded, unanswered] = await Promise.all([
    prisma.surveyInvitation.count({ where: { surveyId } }),
    prisma.surveyInvitation.count({ where: { surveyId, respondedAt: { not: null } } }),
    prisma.surveyInvitation.findMany({
      where: { surveyId, respondedAt: null },
      orderBy: { createdAt: 'asc' },
      select: REMINDER_SELECT,
    }),
  ]);

  const pendingByReminders = Array.from({ length: SURVEY_MAX_REMINDERS + 1 }, (_, k) => unanswered.filter((i) => i.remindersSent === k).length);
  const shown = responded >= floor;
  return {
    survey: { id: survey.id, title: pickLocalized(survey.title, locale), anonymity: survey.anonymity, status: survey.status },
    floor,
    invited,
    responded: shown ? responded : null,
    rate: shown && invited > 0 ? Math.round((responded / invited) * 100) : null,
    maxReminders: SURVEY_MAX_REMINDERS,
    pendingByReminders,
    pending: anonymous
      ? null
      : unanswered.map((inv) => {
          const why = reminderRefusal(inv, now, true);
          return {
            invitationId: inv.id,
            name: inv.user?.fullName ?? null,
            email: inv.email,
            remindersSent: inv.remindersSent,
            lastRemindedAt: inv.lastRemindedAt,
            expiresAt: inv.expiresAt,
            cannotRemind: why && why !== 'not_due' ? why : null,
          };
        }),
  };
}
