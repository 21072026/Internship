// Drop-off reason whitelist for StatusChange.reasonCode (#810). Client-safe —
// no Prisma import — so both API routes and UI components share the exact
// same list. Validated the same way as offer/pipeline status elsewhere in this
// repo: z.string() + this whitelist, never z.enum (CLAUDE.md).

export const DROPOFF_REASON_CODES = [
  'CANDIDATE_WITHDREW',
  'NO_RESPONSE',
  'ACCEPTED_ELSEWHERE',
  'SCHEDULE_CONFLICT',
  'LOCATION',
  'SKILL_MISMATCH',
  'COMPANY_CANCELLED',
  'PERFORMANCE',
  'OTHER',
] as const;

export type DropoffReasonCode = (typeof DROPOFF_REASON_CODES)[number];

export function isDropoffReasonCode(value: string): value is DropoffReasonCode {
  return (DROPOFF_REASON_CODES as readonly string[]).includes(value);
}

// Sentinel used (never stored) for pre-existing StatusChange rows and any
// negative-stage move made before this feature shipped — grouped as
// "Unspecified" in the analytics breakdown rather than dropped or mislabeled.
export const UNSPECIFIED_REASON = 'UNSPECIFIED';
