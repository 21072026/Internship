// Central offer state machine + authorization rules (#809). `Offer.status` is a
// free String in Prisma (same reasoning as MentorshipRelation.pipelineStatus),
// so API routes validate it with z.string() + the whitelist/helpers here rather
// than z.enum — see CLAUDE.md.

export const OFFER_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export function isOfferStatus(value: string): value is OfferStatus {
  return (OFFER_STATUSES as readonly string[]).includes(value);
}

// Allowed forward transitions. Every other status is terminal (no outgoing edges).
const TRANSITIONS: Record<OfferStatus, readonly OfferStatus[]> = {
  DRAFT: ['SENT'],
  SENT: ['ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'],
  ACCEPTED: [],
  DECLINED: [],
  EXPIRED: [],
  WITHDRAWN: [],
};

export function canTransition(from: string, to: string): boolean {
  return isOfferStatus(from) && isOfferStatus(to) && TRANSITIONS[from].includes(to);
}

export const OFFER_ACTIONS = ['send', 'withdraw', 'accept', 'decline'] as const;
export type OfferAction = (typeof OFFER_ACTIONS)[number];

export function isOfferAction(value: string): value is OfferAction {
  return (OFFER_ACTIONS as readonly string[]).includes(value);
}

const ACTION_TRANSITIONS: Record<OfferAction, { from: OfferStatus; to: OfferStatus }> = {
  send: { from: 'DRAFT', to: 'SENT' },
  withdraw: { from: 'SENT', to: 'WITHDRAWN' },
  accept: { from: 'SENT', to: 'ACCEPTED' },
  decline: { from: 'SENT', to: 'DECLINED' },
};

export function transitionForAction(action: OfferAction): { from: OfferStatus; to: OfferStatus } {
  return ACTION_TRANSITIONS[action];
}

// Single place that decides who may run which action on an offer — the rule
// the issue asks to keep server-side and centralized rather than scattered
// across route handlers.
//   ADMIN  — every action.
//   MENTEE — only their own offer, and only accept/decline (never send/withdraw).
//   anyone else (COMPANY, a different MENTEE, ...) — read-only, no actions.
export function canPerformAction(params: {
  role: string;
  isOwnMenteeOffer: boolean;
  currentStatus: string;
  action: OfferAction;
}): boolean {
  const { from, to } = transitionForAction(params.action);
  if (params.currentStatus !== from || !canTransition(from, to)) return false;
  if (params.role === 'ADMIN') return true;
  if (params.role === 'MENTEE') {
    return params.isOwnMenteeOffer && (params.action === 'accept' || params.action === 'decline');
  }
  return false;
}

// Whitelist for the mentee-facing decline reason — validated the same way as
// offer status (z.string() + this list), not a Prisma/Zod enum.
export const DECLINE_REASON_CODES = [
  'COMPENSATION',
  'POSITION',
  'LOCATION',
  'OTHER_OFFER',
  'START_DATE',
  'OTHER',
] as const;
export type DeclineReasonCode = (typeof DECLINE_REASON_CODES)[number];

export function isDeclineReasonCode(value: string): value is DeclineReasonCode {
  return (DECLINE_REASON_CODES as readonly string[]).includes(value);
}

// Canonical default "hired" pipeline stage key (mirrors PipelineStatus.HIRED_660
// in src/lib/pipeline.ts). Used only to decide whether the "move to next stage"
// suggestion is offered after an offer is accepted — never assumed to exist.
export const DEFAULT_HIRED_STAGE_KEY = 'HIRED_660';

// Who may SELECT compensationNote: ADMIN always, and a MENTEE reading their own
// offer (they need it to decide). Nobody else — including COMPANY — per #809's
// explicit "don't even SELECT it for unauthorized roles" requirement.
export function canSeeCompensation(params: { role: string; isOwnMenteeOffer: boolean }): boolean {
  return params.role === 'ADMIN' || (params.role === 'MENTEE' && params.isOwnMenteeOffer);
}

// Every column canSeeCompensation() guards (#1851): the note, and the
// structured figures beside it. Routes build their conditional `select` from
// THIS list, so a column added here is withheld from COMPANY by construction —
// and one added to the schema but not here is a review failure, caught by
// e2e/offers.spec.ts asserting a COMPANY body carries none of them.
export const OFFER_COMPENSATION_FIELDS = [
  'compensationNote',
  'currency',
  'baseAmountMinor',
  'basePeriod',
  'signingBonusMinor',
  'otherBonusMinor',
  'equityNote',
  'hoursPerWeek',
  'contractType',
] as const;
export type OfferCompensationField = (typeof OFFER_COMPENSATION_FIELDS)[number];

/** `{ compensationNote: true, currency: true, … }` for a Prisma `select`. */
export function compensationSelect(): Record<OfferCompensationField, true> {
  return Object.fromEntries(OFFER_COMPENSATION_FIELDS.map((f) => [f, true])) as Record<OfferCompensationField, true>;
}

// The offer letter's frozen text (#1857) states the pay, so it follows the same
// rule: SELECTed only where canSeeCompensation() holds, from this list. The
// acceptance record (acceptedIp / acceptedUserAgent) is ADMIN-only and is
// deliberately not here — a mentee does not need their own IP read back.
export const OFFER_LETTER_FIELDS = ['letterSnapshot', 'letterLocale'] as const;
export type OfferLetterField = (typeof OFFER_LETTER_FIELDS)[number];

export function letterSelect(): Record<OfferLetterField, true> {
  return Object.fromEntries(OFFER_LETTER_FIELDS.map((f) => [f, true])) as Record<OfferLetterField, true>;
}
