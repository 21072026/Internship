/**
 * Group relations (#1804, slice 2): forming a GROUP and seating or unseating
 * people in one. Server-only. The shape check is pure in relationShapes.ts;
 * the seats' one writer is relationParticipants.ts; the one-active-mentor
 * question is activeMentorship.ts — this module only puts them in order.
 *
 * A GROUP is still ONE relation with a scalar pair: the mentor and the first
 * mentee are `mentorId`/`menteeId` (created through the shared create path,
 * so the guard, the mirror seats, the webhook and the decision record are the
 * ones every pairing gets), and every further mentee is a seat. Each seated
 * mentee is mentored — the invariant (#419) holds for them as for the pair,
 * asked inside the same transaction as the write.
 */

import type { User } from '@prisma/client';
import { findActiveMentorship, AlreadyMentoredError } from '@/lib/activeMentorship';
import { isBenched } from '@/lib/participantState';
import { isEligible } from '@/lib/eligibility';

/** The roles that may be in a pairing at all (#1141) — the same list POST /api/mentorship uses. */
export const SEATABLE_USER_ROLES = ['ADMIN', 'MENTOR', 'MENTEE'];

export class GroupRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** A mentee about to be mentored by the group: a participant role, eligible. Throws GroupRefusal. */
export async function assertSeatableMentee(user: Pick<User, 'id' | 'role' | 'orgId'> | undefined, id: string): Promise<void> {
  if (!user || !SEATABLE_USER_ROLES.includes(user.role)) throw new GroupRefusal('invalid_mentee', 400, { userId: id });
  const eligibility = await isEligible({ id: user.id, orgId: user.orgId });
  if (!eligibility.ok) throw new GroupRefusal('not_eligible', 403, { userId: id, reason: eligibility.reason, ruleId: eligibility.ruleId ?? null });
}

/** Someone about to mentor or facilitate: a participant role, active, not benched (#1778). Throws GroupRefusal. */
export function assertSeatableMentor(user: (Pick<User, 'id' | 'role' | 'isActive'> & Parameters<typeof isBenched>[0]) | undefined, id: string): void {
  if (!user || !SEATABLE_USER_ROLES.includes(user.role) || !user.isActive) throw new GroupRefusal('invalid_mentor', 400, { userId: id });
  if (isBenched(user)) throw new GroupRefusal('mentor_benched', 409, { userId: id });
}

/** The programme's mentor rules (#3423) for someone about to mentor; none = everyone stands. Throws GroupRefusal. */
export async function assertEligibleMentor(user: Pick<User, 'id' | 'orgId'>): Promise<void> {
  const eligibility = await isEligible({ id: user.id, orgId: user.orgId }, null, 'MENTOR');
  if (!eligibility.ok) throw new GroupRefusal('not_eligible', 403, { userId: user.id, side: 'mentor', reason: eligibility.reason, ruleId: eligibility.ruleId ?? null });
}

/** The invariant for one more mentee, inside the caller's transaction. Throws AlreadyMentoredError. */
export async function assertNotMentored(tx: Parameters<typeof findActiveMentorship>[0], menteeId: string): Promise<void> {
  const active = await findActiveMentorship(tx, menteeId);
  if (active) throw new AlreadyMentoredError(menteeId, active.id);
}
