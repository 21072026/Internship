/**
 * The bulk matching round's lifecycle (#1793, story #1791) — pure rules, no
 * Prisma. The routes and the cohort pass (#1794) / publish path (#1796) ask
 * here before every write, and every write is a guarded `updateMany` with the
 * status it expects in the WHERE, so two admins cannot race a round past a rule.
 *
 *   Round:    DRAFT ⇄ REVIEW → PUBLISHED (only through the publish path)
 *             DRAFT | REVIEW → DISCARDED
 *             PUBLISHED and DISCARDED are terminal — a published round can never
 *             be re-run, re-published, edited or discarded.
 *   Proposal: DRAFT ⇄ LOCKED, DRAFT | LOCKED → DISCARDED, DISCARDED → DRAFT,
 *             LOCKED → PUBLISHED (publish path only); PUBLISHED is terminal.
 */

export const ROUND_STATUSES = ['DRAFT', 'REVIEW', 'PUBLISHED', 'DISCARDED'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export const PROPOSAL_STATES = ['DRAFT', 'LOCKED', 'DISCARDED', 'PUBLISHED'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** Who is asking: an admin's edit, or the publish path itself. */
export type TransitionActor = 'admin' | 'publish';

const ROUND_EDGES: Record<RoundStatus, readonly RoundStatus[]> = {
  DRAFT: ['REVIEW', 'DISCARDED'],
  REVIEW: ['DRAFT', 'PUBLISHED', 'DISCARDED'],
  PUBLISHED: [],
  DISCARDED: [],
};

export function canTransitionRound(from: RoundStatus, to: RoundStatus, actor: TransitionActor = 'admin'): boolean {
  if (!ROUND_EDGES[from].includes(to)) return false;
  // Publishing is a different operation (relations, plan gate, decisions) — a
  // plain status edit may never reach it.
  if (to === 'PUBLISHED') return actor === 'publish';
  return true;
}

/** Name, proposals, re-run: only while the round is still being worked on. */
export function isRoundEditable(status: RoundStatus): boolean {
  return status === 'DRAFT' || status === 'REVIEW';
}

const PROPOSAL_EDGES: Record<ProposalState, readonly ProposalState[]> = {
  DRAFT: ['LOCKED', 'DISCARDED'],
  LOCKED: ['DRAFT', 'DISCARDED', 'PUBLISHED'],
  DISCARDED: ['DRAFT'],
  PUBLISHED: [],
};

export function canTransitionProposal(from: ProposalState, to: ProposalState, actor: TransitionActor = 'admin'): boolean {
  if (!PROPOSAL_EDGES[from].includes(to)) return false;
  if (to === 'PUBLISHED') return actor === 'publish';
  return true;
}

/** The unmatched reasons a cohort pass may record (#1794); the board translates them. */
export const UNMATCHED_REASONS = ['no_eligible_mentor', 'all_at_capacity', 'below_threshold', 'no_mentors_in_scope'] as const;
export type UnmatchedReason = (typeof UNMATCHED_REASONS)[number];

export const ROUND_NAME_MAX = 120;

/**
 * The board's per-row and bulk actions (#1796), each as the state it moves to
 * and the states it moves from — every pair is an edge `canTransitionProposal`
 * allows an admin. `lock` additionally needs a mentor on the row: an unmatched
 * proposal has nothing to publish.
 */
export const PROPOSAL_ACTIONS = {
  lock: { to: 'LOCKED', from: ['DRAFT'] },
  unlock: { to: 'DRAFT', from: ['LOCKED'] },
  discard: { to: 'DISCARDED', from: ['DRAFT', 'LOCKED'] },
  restore: { to: 'DRAFT', from: ['DISCARDED'] },
} as const satisfies Record<string, { to: ProposalState; from: readonly ProposalState[] }>;
export type ProposalAction = keyof typeof PROPOSAL_ACTIONS;

/** Proposals hold a mentor's seat while they can still be published. */
export const SEAT_HOLDING_STATES = ['DRAFT', 'LOCKED'] as const satisfies readonly ProposalState[];
