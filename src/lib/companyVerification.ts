// Employer verification (#1865, docs/company-verification.md) — pure, no Prisma,
// unit-tested in scripts/test/company-verification.test.mjs.
//
// Fake employer postings aimed at students are the cost of self-serve sign-up,
// so a company that is not VERIFIED reaches NO candidate: it is filtered out of
// the job board's WHERE (src/lib/portalJobs.ts — inside the query, so counts
// and pages stay right), it cannot publish an OPEN requisition, and it cannot
// open the company→candidate channel. It can still sign in, edit its profile
// and draft requisitions.
//
// `Company.verificationStatus` defaults to VERIFIED: every company that existed
// before this was created by an admin. Only the self-signup path writes PENDING.

export const COMPANY_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'] as const;
export type CompanyVerificationStatus = (typeof COMPANY_VERIFICATION_STATUSES)[number];

export function isCompanyVerificationStatus(value: unknown): value is CompanyVerificationStatus {
  return typeof value === 'string' && (COMPANY_VERIFICATION_STATUSES as readonly string[]).includes(value);
}

/** The one visibility rule. An unknown stored value is NOT verified (fail closed). */
export function isCompanyVerified(status: string | null | undefined): boolean {
  return status === 'VERIFIED';
}

/** The Prisma `where` fragment a requisition must match to be candidate-visible. */
export const VERIFIED_COMPANY_WHERE = { company: { is: { verificationStatus: 'VERIFIED' } } } as const;

/** The refusal code every gate answers with (403). */
export const COMPANY_NOT_VERIFIED = 'company_not_verified';

/** A requisition write that would put the role in front of candidates. */
export function publishRefused(input: { companyStatus: string | null | undefined; nextRequisitionStatus: string }): boolean {
  return input.nextRequisitionStatus === 'OPEN' && !isCompanyVerified(input.companyStatus);
}

// ── The admin's decision ─────────────────────────────────────────────────────

export const VERIFICATION_ACTIONS = ['approve', 'reject', 'suspend', 'reinstate'] as const;
export type VerificationAction = (typeof VERIFICATION_ACTIONS)[number];

export function isVerificationAction(value: unknown): value is VerificationAction {
  return typeof value === 'string' && (VERIFICATION_ACTIONS as readonly string[]).includes(value);
}

const ACTION_TABLE: Readonly<Record<VerificationAction, { from: readonly CompanyVerificationStatus[]; to: CompanyVerificationStatus; needsReason: boolean }>> = {
  // A pending sign-up is cleared, or turned away with a reason.
  approve: { from: ['PENDING', 'REJECTED'], to: 'VERIFIED', needsReason: false },
  reject: { from: ['PENDING'], to: 'REJECTED', needsReason: true },
  // A verified company that turns out to be abusive is taken off the board
  // without deleting anything; reinstating puts it back.
  suspend: { from: ['VERIFIED'], to: 'SUSPENDED', needsReason: true },
  reinstate: { from: ['SUSPENDED'], to: 'VERIFIED', needsReason: false },
};

export const VERIFICATION_REASON_MAX = 1000;

export type VerificationRefusal = 'not_allowed' | 'reason_required' | 'reason_too_long';

export function verificationTransition(input: {
  from: string;
  action: VerificationAction;
  reason?: string | null;
}): { ok: true; to: CompanyVerificationStatus; reason: string | null } | { ok: false; code: VerificationRefusal } {
  const rule = ACTION_TABLE[input.action];
  if (!(rule.from as readonly string[]).includes(input.from)) return { ok: false, code: 'not_allowed' };
  const reason = input.reason?.trim() || null;
  if (rule.needsReason && !reason) return { ok: false, code: 'reason_required' };
  if (reason && reason.length > VERIFICATION_REASON_MAX) return { ok: false, code: 'reason_too_long' };
  // The reason belongs to a refusal; approving or reinstating clears it.
  return { ok: true, to: rule.to, reason: rule.needsReason ? reason : null };
}

/** The actions an admin can take on a company in `status` (the screen's buttons). */
export function availableVerificationActions(status: string): VerificationAction[] {
  return VERIFICATION_ACTIONS.filter((a) => (ACTION_TABLE[a].from as readonly string[]).includes(status));
}

// ── What a COMPANY user may change on its own company ───────────────────────

/** Exactly these. Never quota, orgId, name, externalId or verificationStatus. */
export const COMPANY_SELF_EDITABLE_FIELDS = ['description', 'logoUrl', 'industry', 'size', 'address', 'contactEmail'] as const;

/** The keys of a COMPANY user's body that it may not write, sorted (empty = fine). */
export function companySelfEditRefusedFields(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const allowed = COMPANY_SELF_EDITABLE_FIELDS as readonly string[];
  return Object.keys(body).filter((k) => !allowed.includes(k)).sort();
}
