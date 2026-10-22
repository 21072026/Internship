// Where a pairing stands against the mentoring agreement (#1792) — pure and
// client-safe, so the admin list, its filter and the participant card name the
// four states the same way.
//
// THE RULE THIS FILE EXISTS TO KEEP: an unsigned agreement is a PROMPT and a
// LINE ON A REPORT, never a gate. Nothing in the product — messaging, meetings,
// goals, evaluations, the portal, the pipeline — may be disabled because a
// status here is not SIGNED. e2e/mentoring-agreement-kickoff.spec.ts asserts it.

export const AGREEMENT_STATUSES = ['SIGNED', 'MENTOR_ONLY', 'MENTEE_ONLY', 'UNSIGNED'] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

export function isAgreementStatus(v: unknown): v is AgreementStatus {
  return typeof v === 'string' && (AGREEMENT_STATUSES as readonly string[]).includes(v);
}

/** The status from each side's acceptance of the version in force. */
export function agreementStatusOf(mentorAcceptedAt: unknown, menteeAcceptedAt: unknown): AgreementStatus {
  if (mentorAcceptedAt && menteeAcceptedAt) return 'SIGNED';
  if (mentorAcceptedAt) return 'MENTOR_ONLY';
  if (menteeAcceptedAt) return 'MENTEE_ONLY';
  return 'UNSIGNED';
}
