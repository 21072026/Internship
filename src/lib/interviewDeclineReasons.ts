// Interview-request decline reasons (#1416). Client-safe and dependency-free so
// the decision API and the review dialog validate against the same vocabulary.
// Keep these separate from pipeline drop-off reasons: declining one interview
// request does not mean the candidate left the programme pipeline.

export const INTERVIEW_DECLINE_REASON_CODES = [
  'CANDIDATE_IN_OTHER_PROCESS',
  'CANDIDATE_NOT_READY',
  'NO_CONSENT',
  'SCHEDULING_CONFLICT',
  'OTHER',
] as const;

export type InterviewDeclineReasonCode = (typeof INTERVIEW_DECLINE_REASON_CODES)[number];

export function isInterviewDeclineReasonCode(value: string): value is InterviewDeclineReasonCode {
  return (INTERVIEW_DECLINE_REASON_CODES as readonly string[]).includes(value);
}

// Display-only fallback for requests declined before #1416. Never persist it:
// null continues to identify a legacy row rather than inventing a decision.
export const UNSPECIFIED_INTERVIEW_DECLINE_REASON = 'UNSPECIFIED';
