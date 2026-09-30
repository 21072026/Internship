// Accepted offer → hired stage (#2658): the decision, pure and dependency-free
// so `node --test --experimental-strip-types` loads it directly
// (scripts/test/offer-auto-advance.test.mjs). The write is
// src/lib/offerAutoAdvance.ts, through the shared stage write path.
//
// THE RULES:
//   1. Off unless the org opted in (`autoAdvanceOnOfferAccept`). Off is exactly
//      the old behaviour: the offer panel SUGGESTS the move, nothing moves.
//   2. Never invent a stage. The target is the org's hired stage key as its
//      resolved pipeline actually has it; a custom pipeline without one is a
//      skip, not an error.
//   3. Never backwards. A relation already AT or past the hired stage on the
//      path (EMPLOYED_700, a tenant's own "probation passed") stays put.
//      An off-path stage is not "past" anything, so an accepted offer does
//      move a relation out of one: the acceptance is the newer fact.
//   4. Only a live relation. A COMPLETED pairing is history; rewriting its
//      stage from an offer would change what the history says happened.

export interface AdvanceStage {
  key: string;
  order: number;
  isOffPath: boolean;
}

export type AutoAdvanceDecision =
  | { move: true; to: string }
  | { move: false; reason: 'disabled' | 'not_active' | 'no_hired_stage' | 'already_there' };

export function decideOfferAutoAdvance(input: {
  enabled: boolean;
  hiredKey: string;
  stages: readonly AdvanceStage[];
  currentStage: string;
  relationStatus: string;
}): AutoAdvanceDecision {
  if (!input.enabled) return { move: false, reason: 'disabled' };
  if (input.relationStatus !== 'ACTIVE') return { move: false, reason: 'not_active' };
  const hired = input.stages.find((s) => s.key === input.hiredKey);
  if (!hired) return { move: false, reason: 'no_hired_stage' };
  if (input.currentStage === hired.key) return { move: false, reason: 'already_there' };
  const current = input.stages.find((s) => s.key === input.currentStage);
  if (current && !current.isOffPath && current.order >= hired.order) {
    return { move: false, reason: 'already_there' };
  }
  return { move: true, to: hired.key };
}
