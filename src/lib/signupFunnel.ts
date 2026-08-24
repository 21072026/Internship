// Signup funnel: registered → verified → active (#1191).
//
// The whole point is catching a SILENT failure: if verification e-mails stop
// arriving, sign-ups keep happening and nothing else looks wrong — the door
// only looks open. One ratio per window makes that visible without anyone
// watching. Pure module (no Prisma) so the threshold rules stay unit-testable;
// the counts are queried by the admin analytics route.

export interface SignupCounts {
  registered: number;
  verified: number;
  active: number;
}

export interface SignupWindow extends SignupCounts {
  days: number;
  /** Percent, or null with zero sign-ups — never a misleading 0 %. */
  verifiedRate: number | null;
  activeRate: number | null;
  /** Enough volume to judge, and verification is far below par. */
  warn: boolean;
}

/** Below this many sign-ups a low ratio is noise, not a signal. */
export const MIN_SIGNUPS_TO_JUDGE = 5;
/** Verification rate (percent) under which the funnel looks broken. */
export const LOW_VERIFICATION_RATE = 40;

const rate = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 100) : null;

export function buildSignupWindow(days: number, counts: SignupCounts): SignupWindow {
  const verifiedRate = rate(counts.verified, counts.registered);
  return {
    days,
    ...counts,
    verifiedRate,
    activeRate: rate(counts.active, counts.registered),
    // Zero sign-ups can never warn (no division, no false alarm on a quiet week).
    warn: counts.registered >= MIN_SIGNUPS_TO_JUDGE && verifiedRate !== null && verifiedRate < LOW_VERIFICATION_RATE,
  };
}
