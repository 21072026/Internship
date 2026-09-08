import type { ClientDictionary } from '@/i18n/dictionaries';

/**
 * One reader for "why was this assignment (or mentor change) refused?" —
 * #2283 follow-up, extended by #2289.
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
    // The mentor-change refusals (#2289). Same family, same reader: a transfer
    // is an assignment that also closes something, and giving it its own
    // switch is how three call sites drifted apart the first time.
    case 'same_mentor':
    case 'self_mentor':
      return t.changeMentor.sameMentor;
    case 'inactive_relation':
      return t.changeMentor.inactive;
    case 'reason_required':
    case 'invalid_reason':
      return t.changeMentor.reasonRequired;
    case 'note_required':
      return t.changeMentor.noteRequired;
    default:
      return fallback;
  }
}
