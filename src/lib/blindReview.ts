// Blind review (#819, the half that needs no demographic data).
//
// Interviewers anchor on things that are not the work: a name, a photo, the
// university on a CV. Hiding them while the scorecard is written is a
// well-evidenced, low-risk bias reduction — and unlike the rest of #819 it
// collects nothing about anybody, so it ships on its own.
//
// Deliberately NOT a per-reviewer toggle. A bias control that each reviewer
// opts into is a bias control that the reviewers most affected by bias will not
// use; it is a property of how the organisation runs interviews, so it is an
// org setting and it applies to everyone at once.
//
// Scope: the interview panel, and only the interview panel. Blinding a mentee
// whose mentor meets them weekly would be theatre — the first structured
// scoring of somebody you do not know is the one place this changes an outcome.

/**
 * A stable, non-reversible-looking label for a candidate under blind review.
 *
 * Stable so a panel can discuss "candidate A3F2" and mean the same person;
 * derived from the id so nothing extra has to be stored. It is not a secret —
 * anyone with database access can map it back — it exists to remove the
 * *anchor*, not to withstand an attacker.
 */
export function blindLabel(subjectId: string): string {
  let hash = 0;
  for (let i = 0; i < subjectId.length; i++) {
    hash = (hash * 31 + subjectId.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, '0').slice(-4);
}

/**
 * Whether this viewer should still be blind to the candidate's identity.
 *
 * The moment their own scorecard is submitted, the anchor can no longer affect
 * it — so identity comes back, which is what the acceptance criterion asks for
 * ("who it was is visible once the evaluation is saved"). Somebody who is not
 * scoring at all (an admin running the panel) is never blinded: they have no
 * scorecard to bias.
 */
export function isBlindFor(opts: {
  enabled: boolean;
  viewerIsMember: boolean;
  viewerSubmitted: boolean;
}): boolean {
  if (!opts.enabled) return false;
  if (!opts.viewerIsMember) return false;
  return !opts.viewerSubmitted;
}
