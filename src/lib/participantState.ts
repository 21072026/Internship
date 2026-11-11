// A person's participation state (#1778, story #1776) — pure, client-safe.
//
//   ACTIVE  — the default: offered for matching, assignable, nudged.
//   BENCHED — "not this term, but keep them". Still signs in and reads their
//             own record; NOT offered for matching, NOT assignable (refused
//             server-side on every assignment path), skipped by every nudge
//             sweep. Their existing pairings are unaffected — pausing a
//             pairing is the lifecycle endpoint's job (#1770), and the two are
//             independent on purpose.
//
// A bench is never a deactivation: it does not touch `isActive`, does not stamp
// `sessionsValidFrom` (that is revocation, which must also call
// revokeAllTrustedDevices()) and does not move `consentAt` (the retention
// clock). The writer is src/lib/bench.ts.
//
// A free String + this whitelist, never a Prisma enum (repo convention).

export const PARTICIPANT_STATES = ['ACTIVE', 'BENCHED'] as const;
export type ParticipantState = (typeof PARTICIPANT_STATES)[number];

export const BENCHED: ParticipantState = 'BENCHED';
/** One bulk bench touches at most this many people. */
export const BENCH_BATCH_MAX = 500;

export function isParticipantState(value: unknown): value is ParticipantState {
  return typeof value === 'string' && (PARTICIPANT_STATES as readonly string[]).includes(value);
}

export function isBenched(user: { participantState?: string | null } | null | undefined): boolean {
  return user?.participantState === BENCHED;
}

/**
 * Spread into a User `where` to leave the bench out — the matching pools, the
 * directory and every nudge sweep. `{ ...notBenched() }`.
 */
export function notBenched() {
  return { participantState: { not: BENCHED } };
}

/** The refusal every assignment path answers for a benched mentor. */
export const MENTOR_BENCHED_ERROR = { error: 'This mentor is on the bench', code: 'mentor_benched' } as const;
