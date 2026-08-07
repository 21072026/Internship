// Dual role: someone who mentors can also *be* mentored (#1141).
//
// `User.role` stays a single enum — it is what the account was created as, and
// what every authorization decision keys off. What this module adds is the
// orthogonal, *derived* fact that the same person also sits on the other side
// of a mentorship: a mentor who needs help with something themselves, a mentee
// experienced enough to guide a newer one.
//
// Derived, not stored, on purpose. `MentorshipRelation` already permits it —
// mentorId and menteeId are plain user FKs with nothing tying them to a role —
// so the relation table *is* the truth. A second stored flag could disagree
// with it (admin unassigns the last relation, flag stays true, the user keeps a
// dead tab); this cannot.
//
// Both directions are counted, including COMPLETED relations: a finished
// mentorship still has notes, goals and messages the person should reach.

import { prisma } from '@/lib/prisma';
import type { AppMode } from '@/lib/appMode';

export interface MentorshipSides {
  /** Has at least one relation where they are the mentor. */
  mentors: boolean;
  /** Has at least one relation where they are the mentee. */
  isMentored: boolean;
}

/** Which sides of a mentorship this user actually occupies. */
export async function mentorshipSides(userId: string): Promise<MentorshipSides> {
  const [asMentor, asMentee] = await Promise.all([
    prisma.mentorshipRelation.count({ where: { mentorId: userId } }),
    prisma.mentorshipRelation.count({ where: { menteeId: userId } }),
  ]);
  return { mentors: asMentor > 0, isMentored: asMentee > 0 };
}

/**
 * The shells this user may enter, in switcher order. The role grants the shells
 * it always granted; the relation table can only *add* one — never take one
 * away, so a mentor with no mentorship of their own sees exactly what they saw
 * before this feature existed (no switcher at all, for a plain mentor).
 */
export async function availableModes(user: { id: string; role: string }): Promise<AppMode[]> {
  const modes: AppMode[] = [];
  if (user.role === 'ADMIN') modes.push('admin');
  if (user.role === 'ADMIN' || user.role === 'MENTOR') modes.push('mentor');

  const sides = await mentorshipSides(user.id);
  // A mentee-role account that mentors someone gets the mentor shell; anyone
  // being mentored gets the portal, whatever their role says.
  if (user.role === 'MENTEE' && sides.mentors) modes.push('mentor');
  if (user.role === 'MENTEE' || sides.isMentored) modes.push('mentee');

  // A single shell is not a choice — hide the switcher rather than render a
  // one-button group.
  return modes.length > 1 ? modes : [];
}

/**
 * May this user enter the mentee portal? MENTEE by role, or anyone who is
 * actually being mentored. COMPANY/SOURCE accounts never can — they have their
 * own read-only shells and no personal mentorship.
 */
export async function canUsePortal(user: { id: string; role: string }): Promise<boolean> {
  if (user.role === 'MENTEE') return true;
  if (user.role !== 'ADMIN' && user.role !== 'MENTOR') return false;
  return (await mentorshipSides(user.id)).isMentored;
}

/**
 * May this user enter the mentor shell? ADMIN/MENTOR by role, plus a mentee who
 * has been given someone to mentor.
 */
export async function canUseMentorShell(user: { id: string; role: string }): Promise<boolean> {
  if (user.role === 'ADMIN' || user.role === 'MENTOR') return true;
  if (user.role !== 'MENTEE') return false;
  return (await mentorshipSides(user.id)).mentors;
}
