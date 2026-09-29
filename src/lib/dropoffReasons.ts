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

// Why a deal was lost, for the MARKETING funnel (#2573). A rep moving a lead to
// DEAL_LOST was offered "Skill mismatch" and "Location" — hiring reasons that
// mean nothing for a lost sale, so every loss was filed as OTHER and the
// breakdown said nothing. NO_RESPONSE and OTHER are shared on purpose: same
// meaning, same stored code, same label.
export const MARKETING_DROPOFF_REASON_CODES = [
  'PRICE',
  'MISSING_MARKETPLACE',
  'MISSING_FEATURE',
  'COMPETITOR',
  'NO_RESPONSE',
  'NOT_A_FIT',
  'BUSINESS_CLOSED',
  'TECHNICAL_ISSUE',
  'OTHER',
] as const;

export type DropoffReasonCode =
  | (typeof DROPOFF_REASON_CODES)[number]
  | (typeof MARKETING_DROPOFF_REASON_CODES)[number];

/**
 * The reasons a move into an off-path stage may carry in this vertical. A
 * plain string (not VerticalKey) so an unknown or missing vertical is the
 * default product's list, exactly as toVerticalKey() reads it.
 */
export function dropoffReasonCodesFor(vertical: string | null | undefined): readonly DropoffReasonCode[] {
  return vertical === 'MARKETING' ? MARKETING_DROPOFF_REASON_CODES : DROPOFF_REASON_CODES;
}

/** Is `value` one of THIS vertical's reasons? The other product's codes are refused. */
export function isDropoffReasonCodeFor(vertical: string | null | undefined, value: string): value is DropoffReasonCode {
  return (dropoffReasonCodesFor(vertical) as readonly string[]).includes(value);
}

/** Any vertical's reason — for reading stored rows, never for validating a write. */
export function isDropoffReasonCode(value: string): value is DropoffReasonCode {
  return (DROPOFF_REASON_CODES as readonly string[]).includes(value)
    || (MARKETING_DROPOFF_REASON_CODES as readonly string[]).includes(value);
}

// Sentinel used (never stored) for pre-existing StatusChange rows and any
// negative-stage move made before this feature shipped — grouped as
// "Unspecified" in the analytics breakdown rather than dropped or mislabeled.
export const UNSPECIFIED_REASON = 'UNSPECIFIED';
