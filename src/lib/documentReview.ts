// The document review chain (#1859) — the pure half. No Prisma import, so the
// admin form, the review routes, the derivation in documentRequirements.ts and
// the unit spec all read the same rules.
//
// A requirement's approvalMode decides what "satisfied" means:
//   NONE   — today's rule, unchanged: a document attached is a requirement met
//            (unless it was expired by its validity window).
//   SINGLE — the first configured step must approve it (an ADMIN when none is set).
//   CHAIN  — every configured step, in order.
// A document past its validUntil never satisfies anything, whatever the mode.
//
// Changing a requirement's mode never rewrites documents: a file approved (or
// backfilled APPROVED) under NONE still satisfies a later CHAIN, and a file
// waiting in a chain satisfies the requirement at once if it is switched to NONE.
import { z } from 'zod';

export const APPROVAL_MODES = ['NONE', 'SINGLE', 'CHAIN'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const REVIEWER_ROLES = ['MENTOR', 'ADMIN', 'COMPANY', 'EXTERNAL'] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** At most this many steps; longer chains are refused on write. */
export const MAX_REVIEW_STEPS = 5;
export const MAX_VALIDITY_DAYS = 3650;
const LABEL_MAX = 80;

export interface ReviewerStep {
  step: number;
  role: ReviewerRole;
  label?: string;
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value);
}

export function isReviewerRole(value: unknown): value is ReviewerRole {
  return typeof value === 'string' && (REVIEWER_ROLES as readonly string[]).includes(value);
}

/**
 * The stored `reviewerRoles` JSON as an ordered, renumbered list (1, 2, …).
 * Entries that are not a known role are dropped rather than trusted; null when
 * the value is not a list at all.
 */
export function parseReviewerSteps(value: unknown): ReviewerStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps = value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .filter((entry) => isReviewerRole(entry.role))
    .map((entry, index) => ({
      order: typeof entry.step === 'number' && Number.isFinite(entry.step) ? entry.step : index + 1,
      role: entry.role as ReviewerRole,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, LABEL_MAX) : undefined,
    }))
    .sort((a, b) => a.order - b.order);
  return steps.map(({ role, label }, index) => ({ step: index + 1, role, ...(label ? { label } : {}) }));
}

/** The steps a document attached to this requirement must pass, in order. Empty for NONE. */
export function chainFor(requirement: { approvalMode: string; reviewerRoles: unknown }): ReviewerStep[] {
  if (requirement.approvalMode !== 'SINGLE' && requirement.approvalMode !== 'CHAIN') return [];
  const steps = parseReviewerSteps(requirement.reviewerRoles) ?? [];
  const chain = steps.length > 0 ? steps : [{ step: 1, role: 'ADMIN' as const }];
  return requirement.approvalMode === 'SINGLE' ? [chain[0]] : chain;
}

export interface ReviewLike {
  step: number;
  decision: string | null;
}

/** The step waiting for a decision: the lowest undecided one — null once any step rejected or all approved. */
export function nextStep<T extends ReviewLike>(reviews: readonly T[]): T | null {
  const ordered = [...reviews].sort((a, b) => a.step - b.step);
  if (ordered.some((r) => r.decision === 'REJECTED')) return null;
  return ordered.find((r) => r.decision === null) ?? null;
}

export interface DocumentLike {
  reviewStatus: string;
  validUntil: Date | string | null;
}

function current(document: DocumentLike, now: Date): boolean {
  return document.validUntil === null || new Date(document.validUntil).getTime() > now.getTime();
}

/** One document's verdict against its requirement's mode. */
export function documentSatisfies(approvalMode: string, document: DocumentLike, now: Date): boolean {
  if (!current(document, now)) return false;
  if (approvalMode === 'SINGLE' || approvalMode === 'CHAIN') return document.reviewStatus === 'APPROVED';
  // NONE: any attached file counts, exactly as before the chain existed — only
  // an expiry or a rejection (neither of which NONE produces by itself) takes it back.
  return document.reviewStatus !== 'EXPIRED' && document.reviewStatus !== 'REJECTED';
}

/** A requirement is satisfied when at least one of the owner's documents for it satisfies it. */
export function isSatisfied(requirement: { approvalMode: string }, documents: readonly DocumentLike[], now: Date): boolean {
  return documents.some((d) => documentSatisfies(requirement.approvalMode, d, now));
}

/** validFrom / validUntil stamped at approval (or at upload, for NONE). */
export function validityWindow(validityDays: number | null | undefined, now: Date): { validFrom: Date; validUntil: Date | null } {
  const days = typeof validityDays === 'number' && validityDays > 0 ? Math.min(validityDays, MAX_VALIDITY_DAYS) : null;
  return { validFrom: now, validUntil: days ? new Date(now.getTime() + days * 86_400_000) : null };
}

/**
 * Who may decide a step — the flags are derived by the caller from the
 * database, never from a request body. EXTERNAL is never a signed-in decision:
 * that step is decided only through its emailed token.
 */
export function canDecideStep(params: {
  stepRole: string;
  actorRole: string;
  isOwnersActiveMentor: boolean;
  isOwnersCompany: boolean;
  isOwner: boolean;
}): boolean {
  if (params.isOwner) return false; // nobody approves their own document
  switch (params.stepRole) {
    case 'ADMIN':
      return params.actorRole === 'ADMIN';
    case 'MENTOR':
      return params.actorRole === 'MENTOR' && params.isOwnersActiveMentor;
    case 'COMPANY':
      return params.actorRole === 'COMPANY' && params.isOwnersCompany;
    default:
      return false;
  }
}

/** Who may send an EXTERNAL step's link: the programme (ADMIN) or the owner's active mentor — never the owner. */
export function canInviteExternal(params: { actorRole: string; isOwnersActiveMentor: boolean; isOwner: boolean }): boolean {
  if (params.isOwner) return false;
  return params.actorRole === 'ADMIN' || (params.actorRole === 'MENTOR' && params.isOwnersActiveMentor);
}

/** The chain fields as the admin API accepts them; reviewerRoles arrives without step numbers. */
export const reviewChainSchema = {
  approvalMode: z.enum(APPROVAL_MODES).optional(),
  validityDays: z.number().int().min(1).max(MAX_VALIDITY_DAYS).nullable().optional(),
  reviewerRoles: z.array(z.object({ role: z.enum(REVIEWER_ROLES), label: z.string().trim().max(LABEL_MAX).optional() }).strict()).max(MAX_REVIEW_STEPS).optional(),
};

/** The stored shape of reviewerRoles: numbered in the order given, empty labels dropped. */
export function storedReviewerRoles(input: readonly { role: ReviewerRole; label?: string }[]): ReviewerStep[] {
  return input.map((entry, index) => ({ step: index + 1, role: entry.role, ...(entry.label ? { label: entry.label } : {}) }));
}
