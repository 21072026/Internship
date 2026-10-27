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
//
// A third, optional input (#1808): User.selfMatchLimit — how many mentees may
// pick this mentor THEMSELVES (the directory's preferred-mentor request, the
// public per-mentor apply link). It is read only under context 'self_select'
// and only narrows an otherwise `available` mentor to `self_match_full`; an
// admin assigning a mentor is never subject to it — that is the point of
// keeping it apart from mentorCapacity. A caller that passes no context gets
// exactly the pre-#1808 answer (pinned by e2e/mentor-load-controls.unit.spec.ts).

export interface MentorAvailabilityInput {
  /** Max concurrent mentees the mentor is willing to take on. null/undefined = no ceiling set. */
  mentorCapacity: number | null | undefined;
  /** Current count of ACTIVE mentorship relations for this mentor. */
  activeMenteeCount: number;
  /** Mentor's explicit preference. null/undefined = never set (derive from capacity instead). */
  acceptingMentees: boolean | null | undefined;
  /** Max mentees who may pick this mentor themselves. null/undefined = no separate limit (capacity alone). */
  selfMatchLimit?: number | null;
  /** Mentees currently holding a self-selected seat — see countSelfSelected(). */
  selfSelectedCount?: number;
  /** Who is asking. Omitted = 'admin' = the pre-#1808 behaviour. */
  context?: MentorAvailabilityContext;
}

export type MentorAvailabilityContext = 'admin' | 'self_select';

export type MentorAvailabilityStatus =
  // acceptingMentees is explicitly false — always wins, regardless of capacity.
  | 'not_accepting'
  // A numeric mentorCapacity is set and activeMenteeCount has reached/passed it.
  | 'at_capacity'
  // Willing to take a mentee: either said so explicitly, or capacity has room
  // (or no ceiling is set at all).
  | 'available'
  // context 'self_select' only: total capacity has room, but the mentor's own
  // self-match limit is reached — an admin may still assign them.
  | 'self_match_full';

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

export function getMentorAvailability(input: MentorAvailabilityInput): MentorAvailability {
  const base = baseAvailability(input);
  if (input.context !== 'self_select' || base.status !== 'available') return base;
  if (selfMatchReached(input.selfMatchLimit, input.selfSelectedCount ?? 0)) {
    return { ...base, status: 'self_match_full' };
  }
  return base;
}

/** Whether a set self-match limit is reached. null/undefined = no separate limit. */
export function selfMatchReached(selfMatchLimit: number | null | undefined, selfSelectedCount: number): boolean {
  return selfMatchLimit != null && selfSelectedCount >= selfMatchLimit;
}

/**
 * How many self-selected seats a mentor holds (#1808), from rows the caller
 * read: every request that named this mentor as the preferred one and is
 * either still PENDING, or was APPROVED and its mentee is still ACTIVE with
 * this very mentor (an admin who approved it onto someone else freed the
 * seat). Each mentee counts once.
 */
export function countSelfSelected(
  mentorId: string,
  requests: ReadonlyArray<{ menteeId: string; preferredMentorId: string | null; status: string }>,
  activePairs: ReadonlyArray<{ mentorId: string; menteeId: string }>
): number {
  const active = new Set(activePairs.filter((p) => p.mentorId === mentorId).map((p) => p.menteeId));
  const seats = new Set<string>();
  for (const r of requests) {
    if (r.preferredMentorId !== mentorId) continue;
    if (r.status === 'PENDING' || (r.status === 'APPROVED' && active.has(r.menteeId))) seats.add(r.menteeId);
  }
  return seats.size;
}

function baseAvailability({
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
