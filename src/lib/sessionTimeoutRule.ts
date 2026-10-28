// When to warn that a signed-in session is about to end — WCAG 2.2.1 Timing
// Adjustable (#2864). Dependency-free so the unit spec can pin it.
//
// The session is a JWT whose cookie NextAuth re-issues (now + maxAge, 12 h —
// src/lib/auth.ts) every time the browser reads /api/auth/session, so "the
// session expires" means "12 h without the session being read". 2.2.1 wants
// the person warned before that and given a simple way to extend it, with at
// least 20 seconds to respond. Five minutes of lead is well past that floor and
// short enough not to nag someone who is still working. Extending is
// next-auth's `update()`, a POST to the same endpoint, which re-issues the
// cookie with a fresh 12 h.

/** How long before the session ends the warning opens. */
export const SESSION_WARNING_LEAD_MS = 5 * 60 * 1000;

export type SessionWarningPlan =
  | { kind: 'wait'; delayMs: number }
  | { kind: 'warn'; remainingMs: number }
  | { kind: 'expired' }
  | { kind: 'unknown' };

/**
 * What to do now, given the session's `expires` (the ISO string next-auth puts
 * on the client session) and the current time: wait `delayMs` and ask again,
 * warn now (with the time left), or nothing — it already ended, or the value
 * is not a date.
 */
export function planSessionWarning(expires: string | null | undefined, now: number): SessionWarningPlan {
  if (!expires) return { kind: 'unknown' };
  const end = Date.parse(expires);
  if (!Number.isFinite(end)) return { kind: 'unknown' };
  const remainingMs = end - now;
  if (remainingMs <= 0) return { kind: 'expired' };
  if (remainingMs <= SESSION_WARNING_LEAD_MS) return { kind: 'warn', remainingMs };
  return { kind: 'wait', delayMs: remainingMs - SESSION_WARNING_LEAD_MS };
}

/** Whole minutes left, rounded up, never below 1 — what the dialog says. */
export function minutesLeft(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 60_000));
}
