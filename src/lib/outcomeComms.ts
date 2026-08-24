// Negative-outcome communication (#830).
//
// The product's central claim is that a candidate never falls into a black
// hole. The happy path delivers on it — every on-path stage has mentee-facing
// guidance (src/lib/pipeline.ts). The *end* of the road did not: a candidate who
// was dropped, or who found an internship elsewhere, simply watched their stage
// change in silence. For a student a "no" is far better than no answer.
//
// The single distinction this module exists to protect: reaching
// INTERNSHIP_FOUND_ELSEWHERE_800 is a SUCCESS — the student found an internship.
// Communicated with the same template as a rejection, the message lands badly
// and the product's tone breaks. It gets its own, celebratory outcome.

export type OutcomeKind = 'noMatch' | 'placedElsewhere' | 'poolInvite';

/** The e-mail template (in the `emailTemplates` dictionary) each outcome offers. */
export const OUTCOME_TEMPLATE_KEY: Record<OutcomeKind, string> = {
  noMatch: 'outcomeNoMatch',
  placedElsewhere: 'outcomePlacedElsewhere',
  poolInvite: 'outcomePoolInvite',
};

// The drop-off reason (#810) narrows the wording where it actually says
// something about *why*. Only the unambiguous ones are mapped: a candidate who
// took another offer is congratulated, and a stage that ended for reasons that
// are nobody's verdict on them — the company cancelled, the dates or the place
// did not work — is an invitation to stay in the pool rather than a "no". Every
// other code falls back to the stage's own outcome; the mentor edits the draft.
const REASON_OVERRIDE: Record<string, OutcomeKind> = {
  ACCEPTED_ELSEWHERE: 'placedElsewhere',
  COMPANY_CANCELLED: 'poolInvite',
  SCHEDULE_CONFLICT: 'poolInvite',
  LOCATION: 'poolInvite',
};

/**
 * Which outcome a stage transition lands on, or null when the stage is not an
 * end of the road at all.
 *
 * Canonical keys decide first, so the success/rejection split can never be lost
 * to a tenant's stage configuration. A *custom* stage the tenant flagged
 * off-path is an ending too — it just cannot be assumed to be a happy one, so
 * it takes the neutral wording.
 */
export function outcomeForStage(
  stageKey: string,
  opts?: { isOffPath?: boolean; reasonCode?: string | null }
): OutcomeKind | null {
  const base: OutcomeKind | null =
    stageKey === 'INTERNSHIP_FOUND_ELSEWHERE_800'
      ? 'placedElsewhere'
      : stageKey === 'INTERNSHIP_DROPPED_460'
        ? 'noMatch'
        : opts?.isOffPath
          ? 'noMatch'
          : null;
  if (!base) return null;
  return (opts?.reasonCode && REASON_OVERRIDE[opts.reasonCode]) || base;
}

/** True when the outcome is good news and must be phrased as such. */
export function isCelebratory(kind: OutcomeKind): boolean {
  return kind === 'placedElsewhere';
}

/**
 * The concrete next steps offered to the mentee in the portal. Every outcome
 * ends with something to do — that is the difference between an ending and a
 * dead end. Keys are resolved against the `portal.journey.outcome` dictionary
 * block; hrefs are in-app.
 */
export const OUTCOME_ACTIONS: Record<OutcomeKind, { key: string; href: string }[]> = {
  noMatch: [
    { key: 'updateProfile', href: '/portal/profile' },
    { key: 'messageMentor', href: '/portal/messages' },
    { key: 'browseProjects', href: '/projects' },
  ],
  placedElsewhere: [
    { key: 'updateProfile', href: '/portal/profile' },
    { key: 'messageMentor', href: '/portal/messages' },
  ],
  poolInvite: [
    { key: 'updateProfile', href: '/portal/profile' },
    { key: 'messageMentor', href: '/portal/messages' },
  ],
};

/**
 * Where the mentor is sent to write the message: the shared targeted-email
 * composer, with the recipient preselected and the right template applied.
 * Nothing is sent from here — the mentor reads, edits and presses send.
 */
export function outcomeComposerLink(relationId: string, kind: OutcomeKind): string {
  return `/mentor/email?relation=${encodeURIComponent(relationId)}&template=${OUTCOME_TEMPLATE_KEY[kind]}`;
}
