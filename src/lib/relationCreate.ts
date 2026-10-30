/**
 * Creating a mentorship relation — the ONE path (#1796 extracted it from
 * `POST /api/mentorship`, so the bulk round's publish cannot become a second,
 * thinner create that skips the guard, the webhook, the decision record or the
 * notifications). Server-only.
 *
 * Two halves, because they belong on different sides of a commit:
 *   - `createGuardedRelation(tx, …)` runs INSIDE the caller's transaction: the
 *     one-active-mentor guard (#419) and the create, adjacent and atomic. It
 *     throws `AlreadyMentoredError`, which rolls the caller's whole transaction
 *     back — a bulk publish is all or nothing.
 *   - `announceNewRelation(…)` runs AFTER the commit: the `mentorship.created`
 *     event, the per-pairing `MatchDecision` (#1789), the in-app notices to both
 *     sides, the agreement prompt (#1792) and both e-mails (opt-outs honoured).
 *     It must never run for a rolled-back create, and never holds a
 *     transaction open across an SMTP send. It does not throw for a failed
 *     mail or audit write: the pairing is already done.
 *
 * The plan gate (#547) stays with the caller, because only the caller knows
 * how many relations it is about to add (`checkActiveRelationLimit(orgId, n)`).
 */

import type { Prisma, User } from '@prisma/client';
import { emit } from '@/lib/events/emit';
import { notify } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { sendMentorAssignedEmail, sendMenteeAssignedEmail } from '@/services/emailService';
import { findActiveMentorship, AlreadyMentoredError } from '@/lib/activeMentorship';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { recordMatchDecision, type MatchDecisionInput } from '@/lib/matching/decision';
import { writePairSeats } from '@/lib/relationParticipants';

export const NEW_RELATION_INCLUDE = {
  mentor: { select: { id: true, fullName: true, email: true } },
  mentee: { select: { id: true, fullName: true, email: true } },
  company: { select: { id: true, name: true } },
  project: { select: { id: true, name: true } },
} as const;

/** The guard and the create, inside the caller's transaction. Throws AlreadyMentoredError. */
export async function createGuardedRelation(
  tx: Prisma.TransactionClient,
  data: Prisma.MentorshipRelationUncheckedCreateInput,
) {
  const active = await findActiveMentorship(tx, data.menteeId);
  if (active) throw new AlreadyMentoredError(data.menteeId, active.id);
  const relation = await tx.mentorshipRelation.create({ data, include: NEW_RELATION_INCLUDE });
  // The pair's mirror seats (#1804), in the same transaction.
  await writePairSeats(tx, relation);
  return relation;
}

type Person = Pick<User, 'id' | 'fullName' | 'email' | 'orgId'> & Parameters<typeof emailAllowed>[0] & Parameters<typeof emailGroupAllowedForCategory>[0];

export interface AnnounceInput {
  relation: { id: string; orgId: string | null };
  mentor: Person;
  mentee: Person;
  companyId: string | null;
  actor: { id: string; orgId: string | null };
  /** The decision record's own fields; the pair, org and decider come from above. */
  decision: Omit<MatchDecisionInput, 'orgId' | 'relationId' | 'menteeId' | 'mentorId' | 'decidedById'>;
}

export async function announceNewRelation({ relation, mentor, mentee, companyId, actor, decision }: AnnounceInput): Promise<void> {
  await emit(
    'mentorship.created',
    { relationId: relation.id, mentorId: mentor.id, menteeId: mentee.id, companyId },
    { orgId: actor.orgId, actor: { id: actor.id, type: 'user' } },
  );

  // The per-pairing audit record (#1789). Never throws.
  await recordMatchDecision({
    ...decision,
    orgId: relation.orgId,
    relationId: relation.id,
    menteeId: mentee.id,
    mentorId: mentor.id,
    decidedById: actor.id,
  });

  // Neither side should learn about the pairing only by happening to log in
  // (#668). In-app is unconditional; e-mail honours the `mentorship` opt-out.
  await notify(mentee.id, 'mentorship_request.mentorAssigned', { mentorName: mentor.fullName }, '/portal');
  await notify(mentor.id, 'mentorship_request.menteeAssigned', { menteeName: mentee.fullName }, '/mentor');
  // The kickoff prompt (#1792): each side is asked to read the agreement.
  if ((await shellCapabilities(relation.orgId)).includes('mentorship')) {
    await notify(mentee.id, 'agreement.review', {}, '/portal');
    await notify(mentor.id, 'agreement.review', {}, `/mentor/mentees/${relation.id}`);
  }

  // Both halves are mailed, and the `userId`s are not interchangeable: each
  // mail carries an unsubscribe token for its own recipient's account.
  if (mentee.email && emailAllowed(mentee, 'mentorship') && emailGroupAllowedForCategory(mentee, 'mentor-assigned')) {
    try {
      await sendMentorAssignedEmail({ to: mentee.email, menteeName: mentee.fullName, mentorName: mentor.fullName, orgId: mentee.orgId, userId: mentee.id });
    } catch (e) {
      console.error('Mentor assignment email failed:', e);
    }
  }
  if (mentor.email && emailAllowed(mentor, 'mentorship') && emailGroupAllowedForCategory(mentor, 'mentee-assigned')) {
    try {
      await sendMenteeAssignedEmail({ to: mentor.email, mentorName: mentor.fullName, menteeName: mentee.fullName, orgId: mentor.orgId, userId: mentor.id });
    } catch (e) {
      console.error('Mentee assignment email failed:', e);
    }
  }
}
