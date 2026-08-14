// Single source of truth for a mentor's "can I take a new mentee right now?"
// status (#941). Two independent inputs feed it:
//   - User.mentorCapacity   — a headcount ceiling (how many, at most)
//   - User.acceptingMentees — the mentor's own on/off preference (willing to,
//                             right now) — NOT the same thing: a mentor under
//                             capacity can still switch this off (e.g. on
//                             leave), and null means no preference was ever set.
//
// Pure function, no I/O — callers (the #941 mentor-facing screen and the #942
// admin assignment screen) fetch the three inputs themselves and both resolve
// through this one function, so the derivation logic never has to be copied.

export interface MentorAvailabilityInput {
  /** Max concurrent mentees the mentor is willing to take on. null/undefined = no ceiling set. */
  mentorCapacity: number | null | undefined;
  /** Current count of ACTIVE mentorship relations for this mentor. */
  activeMenteeCount: number;
  /** Mentor's explicit preference. null/undefined = never set (derive from capacity instead). */
  acceptingMentees: boolean | null | undefined;
}

export type MentorAvailabilityStatus =
  // acceptingMentees is explicitly false — always wins, regardless of capacity.
  | 'not_accepting'
  // A numeric mentorCapacity is set and activeMenteeCount has reached/passed it.
  | 'at_capacity'
  // Willing to take a mentee: either said so explicitly, or capacity has room
  // (or no ceiling is set at all).
  | 'available';

export interface MentorAvailability {
  status: MentorAvailabilityStatus;
  // Whether `status` came from the mentor's own acceptingMentees choice, or
  // was guessed purely from capacity because no preference is recorded yet.
  source: 'preference' | 'capacity';
  // False when mentorCapacity is null/undefined, i.e. there is no known
  // ceiling to compare activeMenteeCount against. Kept separate from `status`
  // so a caller can say "capacity not set" without it being mistaken for
  // either "available" or "at capacity" — those two only differ once a real
  // number exists.
  capacityKnown: boolean;
}

export function getMentorAvailability({
  mentorCapacity,
  activeMenteeCount,
  acceptingMentees,
}: MentorAvailabilityInput): MentorAvailability {
  const capacityKnown = mentorCapacity != null;
  const atCapacity = capacityKnown && activeMenteeCount >= (mentorCapacity as number);

  // The mentor's explicit "not right now" is authoritative — capacity headroom
  // doesn't override it.
  if (acceptingMentees === false) {
    return { status: 'not_accepting', source: 'preference', capacityKnown };
  }

  if (acceptingMentees === true) {
    // An explicit "yes" still can't be true if they're genuinely full.
    return { status: atCapacity ? 'at_capacity' : 'available', source: 'preference', capacityKnown };
  }

  // acceptingMentees === null/undefined: no manual preference recorded —
  // fall back to a capacity-derived guess.
  return { status: atCapacity ? 'at_capacity' : 'available', source: 'capacity', capacityKnown };
}
