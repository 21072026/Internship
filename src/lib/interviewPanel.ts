// Interview scorecards: blind scoring and panel calibration (#824). Pure, and
// client-safe — the API enforces these rules server-side and the UI uses the
// same functions to decide what to render, so the two can never disagree about
// what "revealed" means.
//
// Why blind scoring exists at all: unstructured interviewing is a well-studied
// weakness. Interviewers anchor on each other, whoever speaks first sets the
// verdict, and the decision gets rationalized afterwards. The fix is
// order-dependent — score independently FIRST, compare SECOND — and if the
// order breaks, the scorecard is theatre.

/** A criterion spread of this many points is worth talking about in calibration. */
export const DIVERGENCE_THRESHOLD = 3;

export interface PanelMemberState {
  userId: string;
  submittedAt: string | Date | null;
}

/**
 * Whether the panel has finished collecting independent scores.
 *
 * Complete = every assigned interviewer submitted, OR an admin closed it. The
 * manual close exists because a no-show interviewer must not be able to hold
 * the calibration view hostage for ever.
 */
export function isPanelComplete(members: PanelMemberState[], closedAt: Date | string | null): boolean {
  if (closedAt) return true;
  return members.length > 0 && members.every((m) => !!m.submittedAt);
}

/**
 * May this viewer see the OTHER interviewers' scorecards?
 *
 * Two independent gates, and both have to hold for a member:
 *   1. the panel is complete — nobody reads anyone before the collection ends;
 *   2. the viewer has committed their own scores — you do not get to read the
 *      room and then write your verdict.
 *
 * An admin who is not on the panel is only bound by the first: they have
 * nothing to submit, and the calibration view is theirs to run.
 */
export function canSeeOtherScorecards(opts: {
  members: PanelMemberState[];
  closedAt: Date | string | null;
  viewerId: string;
  viewerIsAdmin: boolean;
}): boolean {
  const complete = isPanelComplete(opts.members, opts.closedAt);
  if (!complete) return false;
  const me = opts.members.find((m) => m.userId === opts.viewerId);
  if (!me) return opts.viewerIsAdmin;
  // A member who never submitted stays blind even after the panel closes —
  // otherwise "wait and read the others" would be a strictly better strategy
  // than scoring.
  return !!me.submittedAt || opts.viewerIsAdmin;
}

export interface CriterionDivergence {
  key: string;
  min: number;
  max: number;
  spread: number;
  /** Worth discussing: the panel did not see the same person. */
  flagged: boolean;
  scores: { userId: string; score: number }[];
}

/**
 * Per-criterion spread across the submitted scorecards. Criteria nobody scored
 * are left out entirely rather than reported as a spread of zero.
 */
export function divergence(
  criteriaKeys: string[],
  scorecards: { authorId: string; scores: Record<string, unknown> }[]
): CriterionDivergence[] {
  const out: CriterionDivergence[] = [];
  for (const key of criteriaKeys) {
    const scores = scorecards
      .map((s) => ({ userId: s.authorId, score: s.scores?.[key] }))
      .filter((s): s is { userId: string; score: number } => typeof s.score === 'number');
    if (scores.length === 0) continue;
    const values = scores.map((s) => s.score);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min;
    out.push({ key, min, max, spread, flagged: spread >= DIVERGENCE_THRESHOLD, scores });
  }
  return out;
}

/** The panel's overall average across every submitted score. */
export function panelAverage(scorecards: { scores: Record<string, unknown> }[]): number | null {
  const values = scorecards.flatMap((s) =>
    Object.values(s.scores ?? {}).filter((v): v is number => typeof v === 'number' && v >= 1 && v <= 5)
  );
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}
