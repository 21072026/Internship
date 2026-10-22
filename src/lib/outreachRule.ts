// Company → candidate message requests (#1840) — the dependency-free rules.
// The routes (src/app/api/company/outreach, src/app/api/outreach) and the
// message gate (canMessage in src/lib/conversations.ts) read these; the unit
// test is scripts/test/candidate-outreach.test.mjs and docs/candidate-outreach.md
// is the prose.
//
// THE SHAPE. A company may ask to message a candidate it has shortlisted and
// who has opted into being visible to companies. The request waits (PENDING)
// with its first message STORED, not delivered, until the candidate's active
// mentor or an admin decides. Approved → the message lands in a DIRECT
// conversation between the requesting company user and the candidate.
// Declined → nothing is delivered and the company learns "not approved", never
// why. The candidate can revoke an approved channel at any time; a revoked
// one blocks a new request for REVOKE_COOLDOWN_DAYS.
//
// FREE CORE: nothing a candidate or a mentor does here is gated by a plan.
// The only limit is the company's monthly quota, checked when it asks.

export const OUTREACH_STATUSES = ['PENDING', 'APPROVED', 'DECLINED', 'REVOKED'] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export const REVOKE_COOLDOWN_DAYS = 90;
export const MAX_FIRST_MESSAGE = 2000;

/** Application stages at which a candidate counts as shortlisted by the company. */
export const SHORTLISTED_OR_LATER = ['SHORTLISTED', 'INTERVIEW', 'OFFER', 'HIRED'] as const;

export function isOutreachStatus(v: unknown): v is OutreachStatus {
  return typeof v === 'string' && (OUTREACH_STATUSES as readonly string[]).includes(v);
}

/** The status a decision moves a PENDING request to. Only PENDING is decidable. */
export function decisionTarget(current: string, decision: 'APPROVE' | 'DECLINE'): OutreachStatus | null {
  if (current !== 'PENDING') return null;
  return decision === 'APPROVE' ? 'APPROVED' : 'DECLINED';
}

/** Only an APPROVED channel can be revoked, and only by the candidate. */
export function canRevoke(current: string): boolean {
  return current === 'APPROVED';
}

export type RequestRefusal = 'pending' | 'already_approved' | 'cooldown';

/**
 * May the company (re)request, given the existing row for this pair (one row
 * per company × candidate)? A PENDING or APPROVED row stands; a REVOKED row
 * blocks for the cooldown; a DECLINED row may be asked again — a mentor's
 * "not now" is not a permanent ban.
 */
export function requestRefusal(existing: { status: string; revokedAt: Date | null } | null, now: Date): RequestRefusal | null {
  if (!existing) return null;
  if (existing.status === 'PENDING') return 'pending';
  if (existing.status === 'APPROVED') return 'already_approved';
  if (existing.status === 'REVOKED' && existing.revokedAt) {
    const until = existing.revokedAt.getTime() + REVOKE_COOLDOWN_DAYS * 86_400_000;
    if (now.getTime() < until) return 'cooldown';
  }
  return null;
}

/** The calendar month (UTC) a quota counts approvals in: [start, end). */
export function quotaPeriod(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/** The monthly limit: the company's own quota when set (>= 0), else the org setting, else 20. */
export function quotaLimit(companyQuota: number | null | undefined, setting: string | null | undefined): number {
  if (typeof companyQuota === 'number' && Number.isInteger(companyQuota) && companyQuota >= 0) return companyQuota;
  const n = Number.parseInt(setting ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

/**
 * What a company may see of its own request: the status, and for a declined
 * one only that it was not approved. Who decided and why never leave the org.
 */
export function companyView(row: { id: string; menteeId: string; status: string; createdAt: Date; decidedAt: Date | null }) {
  return {
    id: row.id,
    menteeId: row.menteeId,
    status: row.status === 'REVOKED' ? 'CLOSED' : row.status,
    createdAt: row.createdAt,
    decidedAt: row.status === 'PENDING' ? null : row.decidedAt,
  };
}
