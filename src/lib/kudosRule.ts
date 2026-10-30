// Kudos (#1868): a written, attributed thank-you between the two people of a
// mentorship — the one rule for who may send one to whom and who may read them.
// Pure, client-safe and unit-tested (scripts/test/kudos.test.mjs).
//
// Two product limits are load-bearing and not configurable:
//   - NO gamification. A kudo is a sentence a person wrote, never a number:
//     no points, score, level, streak, tier, badge or ranking, here or in the
//     schema. The product's do-not-build list says so explicitly.
//   - Never anonymous and never public. The sender is always named; a kudo is
//     read by the pair and the programme's admins only — no public surface
//     shows one (a later opt-in would be the recipient's own decision).

export const KUDO_PRESETS = [
  'clearFeedback',
  'wellPrepared',
  'unblockedMe',
  'extraMile',
  'greatQuestions',
  'steadyProgress',
] as const;
export type KudoPreset = (typeof KUDO_PRESETS)[number];

export function isKudoPreset(value: unknown): value is KudoPreset {
  return typeof value === 'string' && (KUDO_PRESETS as readonly string[]).includes(value);
}

type Pair = { mentorId: string; menteeId: string };

/**
 * Why a send is refused, or null when it is allowed. `isAdmin` is the caller's
 * admin reach over the relation's org, decided by the route (authz), never by
 * the body. The recipient is always one side of the pair; the sender is the
 * OTHER side, or an admin thanking either side. Nobody thanks themselves.
 */
export function kudoSendRefusal(
  rel: Pair,
  senderId: string,
  recipientId: string,
  isAdmin: boolean,
): 'not_participant' | 'self' | null {
  if (recipientId !== rel.mentorId && recipientId !== rel.menteeId) return 'not_participant';
  if (recipientId === senderId) return 'self';
  const otherSide = senderId === rel.mentorId ? rel.menteeId : senderId === rel.menteeId ? rel.mentorId : null;
  if (otherSide === recipientId) return null;
  return isAdmin ? null : 'not_participant';
}

/** The pair and the programme's admins read a relation's kudos; nobody else. */
export function canReadKudos(rel: Pair, viewerId: string, isAdmin: boolean): boolean {
  return isAdmin || viewerId === rel.mentorId || viewerId === rel.menteeId;
}
