// What a closed interview panel may decide, and where that decision moves the
// application (#1846). Pure: no Prisma, so the panel view can import the
// vocabulary and the unit test can pin the mapping.
//
// The pipeline stage of the mentee's relation is a separate question answered
// only on an explicit `advancePipeline` flag — "recommend, never apply" is the
// convention (src/lib/offers.ts), and a rejection by one company never moves
// a person's programme stage at all.
import { canTransition, isTerminalStage, nextStages, type ApplicationStage } from '@/lib/applications';

export const INTERVIEW_OUTCOMES = ['ADVANCE', 'REJECT', 'OFFER'] as const;
export type InterviewOutcome = (typeof INTERVIEW_OUTCOMES)[number];

export function isInterviewOutcome(value: string): value is InterviewOutcome {
  return (INTERVIEW_OUTCOMES as readonly string[]).includes(value);
}

/**
 * The application stage a decision moves the application to from `current`,
 * or null when the funnel has no such step (a rejected application cannot be
 * advanced; an offer needs an interview first; an application already at
 * OFFER has no next open stage — the hire is the offer flow's job).
 *   ADVANCE — the next OPEN stage in the funnel (SHORTLISTED → INTERVIEW,
 *             INTERVIEW → OFFER): the candidate passed this round.
 *   OFFER   — straight to OFFER, when the funnel allows it from here.
 *   REJECT  — REJECTED, with a disposition code (the route enforces it).
 */
export function outcomeTargetStage(decision: InterviewOutcome, current: string): ApplicationStage | null {
  switch (decision) {
    case 'REJECT':
      return canTransition(current, 'REJECTED') ? 'REJECTED' : null;
    case 'OFFER':
      return canTransition(current, 'OFFER') ? 'OFFER' : null;
    case 'ADVANCE':
      return nextStages(current).find((stage) => !isTerminalStage(stage)) ?? null;
  }
}

/** A rejection never moves the programme pipeline; the other two may, on request. */
export function outcomeMayAdvancePipeline(decision: InterviewOutcome): boolean {
  return decision !== 'REJECT';
}

/** The notification the company receives — the outcome only, never a score. */
export function outcomeNotificationKey(decision: InterviewOutcome): string {
  return `interview_panel.outcome.${decision.toLowerCase()}`;
}
