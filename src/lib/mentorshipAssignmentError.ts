import type { ClientDictionary } from '@/i18n/dictionaries';

/**
 * One reader for "why was this assignment refused?" — #2283 follow-up.
 *
 * The assignment surfaces stopped rendering the server's English `error`
 * literal (correct: it is developer text, never translated). But they each
 * switched on `already_mentored` alone, so every OTHER refusal collapsed into
 * a generic "could not be created" — including the plan gate's 403, which is
 * the one refusal that tells the admin what to actually DO about it
 * (planLimitError, src/lib/planGate.ts). Three call sites drifting apart is
 * how that happened, so the mapping lives here once.
 *
 * Unknown codes still fall back to the caller's generic line: a route that
 * grows a new refusal shows the safe sentence, not whatever English text it
 * happens to carry.
 */
export function mentorshipAssignmentError(
  t: ClientDictionary,
  body: unknown,
  fallback: string,
): string {
  const b = (body ?? {}) as { code?: unknown; usage?: unknown; limit?: unknown; plan?: unknown };
  switch (b.code) {
    case 'already_mentored':
      return t.assignMentor.alreadyAssigned;
    case 'plan_limit_reached':
      // The 403 body carries usage/limit/plan precisely so the UI can say
      // which quota was hit instead of "something went wrong".
      return t.mentorships.planLimitReached
        .replace('{usage}', String(b.usage ?? '?'))
        .replace('{limit}', String(b.limit ?? '?'))
        .replace('{plan}', String(b.plan ?? '?'));
    case 'already_decided':
      return t.mentorships.requestAlreadyDecided;
    case 'invalid_mentor':
      return t.mentorships.invalidMentor;
    default:
      return fallback;
  }
}
