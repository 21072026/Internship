// Who may read which survey answer (#1879) — the ONE place that decides it.
// Pure: no Prisma, no session lookups; the caller loads the facts (the
// viewer, the survey's mode, the respondent and their mentors) and asks. A
// rule enforced in a component is a convention; this is the rule.
// docs/surveys.md states what each mode promises, in words we repeat to buyers.

export type SurveyAnonymityMode = 'IDENTIFIED' | 'CONFIDENTIAL' | 'ANONYMOUS';

/** The default response floor. A survey may raise it, never lower it. */
export const SURVEY_MIN_RESPONSES = 5;

/** The floor a survey actually applies: its own, but never below the default. */
export function effectiveMinResponses(surveyMin?: number | null): number {
  return Math.max(SURVEY_MIN_RESPONSES, surveyMin ?? 0);
}

export interface PrivacyViewer {
  id: string;
  role: string;
}

export interface PrivacyResponse {
  /** Null for every ANONYMOUS response — the link is never written. */
  respondentId: string | null;
  /** Mentors of the respondent (any of their relations), loaded by the caller. */
  respondentMentorIds: readonly string[];
}

/**
 * May `viewer` read this one response (answers, free text) on its own?
 *
 *   ANONYMOUS     — never, for anyone: there is no person to attach it to,
 *                   and an individual answer in a small group is a person.
 *   respondent's mentor — never, in any mode: a mentor reading their own
 *                   mentee's answer about them is exactly what stops honest
 *                   answers. Checked before everything else that could allow.
 *   the respondent — their own answer, in IDENTIFIED and CONFIDENTIAL.
 *   ADMIN         — only in IDENTIFIED; CONFIDENTIAL promises aggregates only.
 */
export function canReadIndividualResponse(
  viewer: PrivacyViewer,
  survey: { anonymity: SurveyAnonymityMode },
  response: PrivacyResponse,
): boolean {
  if (survey.anonymity === 'ANONYMOUS') return false;
  if (response.respondentMentorIds.includes(viewer.id)) return false;
  if (response.respondentId !== null && response.respondentId === viewer.id) return true;
  return viewer.role === 'ADMIN' && survey.anonymity === 'IDENTIFIED';
}

export interface ResponseBucket<T = unknown> {
  key: string;
  n: number;
  data?: T;
}

export type FlooredBucket<T = unknown> =
  | { key: string; suppressed: false; n: number; data?: T }
  | { key: string; suppressed: true };

/**
 * Apply the response floor to a breakdown. Every bucket under the floor is
 * suppressed — its count with it, since "3 people" is itself the leak — and
 * so is the residual: next to a published total, the hidden buckets TOGETHER
 * can be recovered by subtraction, so while they add up to fewer than the
 * floor the smallest shown bucket is hidden with them (#1910 — #1879 only did
 * this for a single hidden bucket, which left two hidden buckets of 1 and 2
 * readable as a group of 3). A "everyone else" bucket is just a bucket here
 * and gets no exemption.
 */
export function applyResponseFloor<T>(buckets: ResponseBucket<T>[], minResponses?: number | null): FlooredBucket<T>[] {
  const floor = effectiveMinResponses(minResponses);
  const hidden = new Set(buckets.filter((b) => b.n < floor).map((b) => b.key));
  const shown = buckets.filter((b) => !hidden.has(b.key)).sort((a, b) => a.n - b.n || a.key.localeCompare(b.key));
  let hiddenTotal = buckets.filter((b) => hidden.has(b.key)).reduce((sum, b) => sum + b.n, 0);
  while (hidden.size > 0 && hiddenTotal < floor && shown.length > 0) {
    const next = shown.shift()!;
    hidden.add(next.key);
    hiddenTotal += next.n;
  }
  return buckets.map((b) => (hidden.has(b.key) ? { key: b.key, suppressed: true as const } : { key: b.key, suppressed: false as const, n: b.n, data: b.data }));
}
