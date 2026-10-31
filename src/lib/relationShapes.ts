// What SHAPE a mentorship relation is, and the seats in it (#1804).
// Client-safe (no Prisma import) so routes and UI share one list — validated
// like the drop-off reasons and the relation kinds: z.string() + this
// whitelist, never z.enum (CLAUDE.md, src/lib/placementKind.ts).
//
// `relationType` answers WHAT SHAPE a relation is; `kind` (placementKind.ts)
// answers WHY it exists. Two different questions on purpose.

export const RELATION_TYPES = ['ONE_TO_ONE', 'GROUP', 'PEER', 'REVERSE', 'FLASH'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];
export const DEFAULT_RELATION_TYPE: RelationType = 'ONE_TO_ONE';

export function isRelationType(value: unknown): value is RelationType {
  return typeof value === 'string' && (RELATION_TYPES as readonly string[]).includes(value);
}

export const PARTICIPANT_ROLES = ['MENTOR', 'MENTEE', 'FACILITATOR'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export function isParticipantRole(value: unknown): value is ParticipantRole {
  return typeof value === 'string' && (PARTICIPANT_ROLES as readonly string[]).includes(value);
}

/** The largest group an admin may form in one step; a circle, not a webinar. */
export const GROUP_MAX_MENTEES = 25;

export interface Seat {
  userId: string;
  role: string;
  isPrimaryPair: boolean;
  leftAt: Date | null;
}

/**
 * Who is IN a relation now: the scalar pair, always — a relation may predate
 * its seat rows, and the primary pair stays for as long as the relation
 * exists — plus every other seat nobody has left. A left seat is history,
 * not access.
 */
export function currentMemberIds(
  relation: { mentorId: string; menteeId: string },
  seats: readonly Seat[],
): Set<string> {
  const ids = new Set<string>([relation.mentorId, relation.menteeId]);
  // A primary-pair seat mirrors the scalars and grants nothing of its own.
  for (const s of seats) if (s.leftAt === null && !s.isPrimaryPair) ids.add(s.userId);
  return ids;
}

/** The seats a relation must have for its scalar pair — what the backfill and every create path write. */
export function pairSeats(relation: { mentorId: string; menteeId: string }): { userId: string; role: ParticipantRole; isPrimaryPair: true }[] {
  return [
    { userId: relation.mentorId, role: 'MENTOR', isPrimaryPair: true },
    { userId: relation.menteeId, role: 'MENTEE', isPrimaryPair: true },
  ];
}

export type GroupMembersRefusal = 'too_few' | 'too_many' | 'duplicate' | 'self';

/**
 * The shape check of a new GROUP, before any database question: one mentor
 * and 2…GROUP_MAX_MENTEES distinct mentees, the mentor not among them. A group
 * of one is a one-to-one and goes through POST /api/mentorship.
 */
export function checkGroupMembers(mentorId: string, menteeIds: readonly string[]): GroupMembersRefusal | null {
  if (new Set(menteeIds).size !== menteeIds.length) return 'duplicate';
  if (menteeIds.includes(mentorId)) return 'self';
  if (menteeIds.length < 2) return 'too_few';
  if (menteeIds.length > GROUP_MAX_MENTEES) return 'too_many';
  return null;
}
