// The Application state machine and its one authorization rule (#1828).
//
// An Application is "this person is being considered for this role, and here
// is where they are in it" — the row the per-role funnel, the interview
// outcome and the offer all read. This module is PURE: no Prisma import, so a
// client component can import the vocabulary, and the plain-ESM mirror the
// deploy backfill uses (scripts/applications-backfill-lib.mjs, Node 20 cannot
// import TS) is compared against it by scripts/test/applications.test.mjs.
//
// Stage, status and source are plain String columns validated against the
// whitelists here, never Prisma enums (the convention of Offer.status, see
// src/lib/offers.ts) — a new stage is a code change, not a schema migration.

/** The fine-grained funnel step, in funnel order; the last three are terminal. */
export const APPLICATION_STAGES = [
  'APPLIED',
  'SCREENING',
  'SHORTLISTED',
  'INTERVIEW',
  'OFFER',
  'HIRED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

export function isApplicationStage(value: string): value is ApplicationStage {
  return (APPLICATION_STAGES as readonly string[]).includes(value);
}

/**
 * The coarse outcome a report counts without knowing the stage vocabulary:
 * everything before a decision is ACTIVE. Derived from the stage by
 * statusForStage() and never set by hand, so the two cannot disagree.
 */
export const APPLICATION_STATUSES = ['ACTIVE', 'HIRED', 'REJECTED', 'WITHDRAWN'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const TERMINAL_STAGES = ['HIRED', 'REJECTED', 'WITHDRAWN'] as const;
export type TerminalStage = (typeof TERMINAL_STAGES)[number];

export function isTerminalStage(stage: string): stage is TerminalStage {
  return (TERMINAL_STAGES as readonly string[]).includes(stage);
}

export function statusForStage(stage: ApplicationStage): ApplicationStatus {
  return isTerminalStage(stage) ? stage : 'ACTIVE';
}

/** How the row came to exist: the candidate applied, a company shortlisted, or an admin entered it. */
export const APPLICATION_SOURCES = ['SELF', 'SHORTLIST', 'ADMIN'] as const;
export type ApplicationSource = (typeof APPLICATION_SOURCES)[number];

export function isApplicationSource(value: string): value is ApplicationSource {
  return (APPLICATION_SOURCES as readonly string[]).includes(value);
}

// Allowed transitions, as an explicit adjacency table (the shape of
// src/lib/offers.ts). The funnel only moves forward; a rejection or a
// withdrawal is reachable from every open stage; terminal stages have no
// outgoing edge. A rejected candidate considered again for a NEW role gets a
// new row (that is #1836's rediscovery), never a reopened one.
const TRANSITIONS: Record<ApplicationStage, readonly ApplicationStage[]> = {
  APPLIED: ['SCREENING', 'SHORTLISTED', 'REJECTED', 'WITHDRAWN'],
  SCREENING: ['SHORTLISTED', 'REJECTED', 'WITHDRAWN'],
  SHORTLISTED: ['INTERVIEW', 'REJECTED', 'WITHDRAWN'],
  INTERVIEW: ['OFFER', 'REJECTED', 'WITHDRAWN'],
  OFFER: ['HIRED', 'REJECTED', 'WITHDRAWN'],
  HIRED: [],
  REJECTED: [],
  WITHDRAWN: [],
};

export function canTransition(from: string, to: string): boolean {
  return isApplicationStage(from) && isApplicationStage(to) && TRANSITIONS[from].includes(to);
}

/** The stages reachable from `from` in one step (empty for a terminal stage or an unknown one). */
export function nextStages(from: string): readonly ApplicationStage[] {
  return isApplicationStage(from) ? TRANSITIONS[from] : [];
}

// Why a candidate was not taken — required on every move to REJECTED (the
// same rule as an offer decline's declineReasonCode), because a rejection
// without a code is invisible when the next requisition opens.
export const DISPOSITION_CODES = [
  'SKILLS',
  'EXPERIENCE',
  'LANGUAGE',
  'LOCATION',
  'AVAILABILITY',
  'ROLE_FILLED',
  'OTHER',
] as const;
export type DispositionCode = (typeof DISPOSITION_CODES)[number];

export function isDispositionCode(value: string): value is DispositionCode {
  return (DISPOSITION_CODES as readonly string[]).includes(value);
}

export function requiresDispositionCode(to: string): boolean {
  return to === 'REJECTED';
}

/**
 * The stages a COMPANY may set on an application to its OWN requisition.
 * Interviews are brokered by the programme (#807) and offers and hires are
 * run by the programme's admins and mentors, so a company screens,
 * shortlists and rejects — nothing else.
 */
export const COMPANY_TARGET_STAGES: readonly ApplicationStage[] = ['SCREENING', 'SHORTLISTED', 'REJECTED'];

// The single place that decides who may move an application where — kept
// server-side and centralized rather than scattered across handlers, exactly
// like canPerformAction in src/lib/offers.ts. Every flag is derived by the
// caller from the DATABASE (the requisition's companyId, the active
// mentorship), never from the request body.
//   ADMIN   — every legal transition.
//   MENTOR  — every legal transition, but only for a mentee they actively mentor.
//   MENTEE  — only their own application, and only to WITHDRAWN.
//   COMPANY — only applications to their own requisition, and only to
//             COMPANY_TARGET_STAGES.
//   anyone else — nothing.
export function canPerformApplicationAction(params: {
  role: string;
  isOwnApplication: boolean;
  isOwningCompany: boolean;
  /** The actor is the mentee's ACTIVE mentor (resolved by the caller, #419). */
  isMenteesMentor?: boolean;
  from: string;
  to: string;
}): boolean {
  if (!canTransition(params.from, params.to)) return false;
  switch (params.role) {
    case 'ADMIN':
      return true;
    case 'MENTOR':
      return params.isMenteesMentor === true;
    case 'MENTEE':
      return params.isOwnApplication && params.to === 'WITHDRAWN';
    case 'COMPANY':
      return params.isOwningCompany && COMPANY_TARGET_STAGES.includes(params.to as ApplicationStage);
    default:
      return false;
  }
}

// ── The bridge from CompanyInterest ──────────────────────────────────────────
// CompanyInterest stays in place as the company's flat three-value flag; this
// is the ONLY place that says what each value means as an application, used by
// the deploy backfill (through its ESM mirror) and by the shortlist write-through
// of #1836, so the two models cannot drift. A legacy interest with no
// requisition is not an application to anything and maps to null.

export const INTEREST_STAGE: Readonly<Record<'INTERESTED' | 'SHORTLISTED' | 'PASS', ApplicationStage>> = {
  INTERESTED: 'SCREENING',
  SHORTLISTED: 'SHORTLISTED',
  PASS: 'REJECTED',
};

export interface InterestLike {
  requisitionId: string | null;
  menteeId: string;
  companyId: string;
  status: string;
  note?: string | null;
}

export interface ApplicationSeed {
  requisitionId: string;
  menteeId: string;
  companyId: string;
  source: 'SHORTLIST';
  stage: ApplicationStage;
  status: ApplicationStatus;
  /** A PASS carries no reason code today, so it lands as OTHER with the note as the elaboration. */
  dispositionCode: DispositionCode | null;
  dispositionNote: string | null;
}

export function applicationFromInterest(interest: InterestLike): ApplicationSeed | null {
  if (!interest.requisitionId) return null;
  if (!(interest.status in INTEREST_STAGE)) return null;
  const stage = INTEREST_STAGE[interest.status as keyof typeof INTEREST_STAGE];
  const rejected = stage === 'REJECTED';
  const note = interest.note?.trim() || null;
  return {
    requisitionId: interest.requisitionId,
    menteeId: interest.menteeId,
    companyId: interest.companyId,
    source: 'SHORTLIST',
    stage,
    status: statusForStage(stage),
    dispositionCode: rejected ? 'OTHER' : null,
    dispositionNote: rejected ? note : null,
  };
}
