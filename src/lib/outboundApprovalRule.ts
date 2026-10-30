// Outbound approval (#2960, docs/outbound-approval.md): which automated mail an
// organization holds for an operator instead of sending it.
//
// THE ONE RULE. `sendEmail()` (src/services/emailService.ts) asks
// `outboundDecision()` about every prepared mail; a `hold` answer turns the mail
// into an OutboundDraft (src/lib/outboundDrafts.ts) that an operator previews
// and then sends now, schedules or discards. Nothing else decides it, and no
// sender may route around it except through the approval itself, which hands
// the draft straight to the mail queue.
//
// THE SETTING. `outboundApproval`, per org through the settings chain:
//   'off'       — default; mail behaves exactly as it always has.
//   'lead_mail' — automated mail to a lead or a customer is held.
// Only a vertical with the sales surface (pipeline, no mentorship — MARKETING)
// can turn it on: anywhere else the mode reads 'off' whatever a row says, so an
// internship tenant can never stop its own mail by a stray setting.
//
// WHO IS STAFF. The org's own ADMIN and MENTOR accounts (a MENTOR of a MARKETING
// org is a sales rep, src/lib/salesSurface.ts). Their mail is never held: it is
// the team's own work. Everybody else is a recipient the switch exists for:
//   lead     — a MENTEE row: the person on a funnel record;
//   customer — a COMPANY row: a customer's login;
//   contact  — an address with no account of this org (a company contact, an
//              enquiry's sender, a meeting guest);
//   other    — any other role (SOURCE has no place in a sales org; held, fail safe).
//
// WHICH MAIL. Every category the product sends is listed below with a reason;
// the exempt ones still leave with approval on:
//   • the essential `account_security` group — sign-in, verification, password,
//     invitation, security notices, operator alerts, and `consent`, which is
//     the demo form's double-opt-in confirmation — EXCEPT `retention-reminder`,
//     a cron's re-consent ask the person never triggered, which is held;
//   • mail the person triggered themselves — the acknowledgement of their own
//     application (`mentor-application-received`).
// An UNKNOWN or missing category is HELD (fail safe): a new sender nobody
// classified must not reach a lead unseen. The unit test pins that every
// category of src/lib/emailGroups.ts has an entry here, so a new category is a
// decision somebody makes, not a default somebody inherits.
//
// Pure and dependency-free (type import only), so the unit runner loads it.

import type { VerticalCapability } from '@/lib/verticals';

export const OUTBOUND_APPROVAL_MODES = ['off', 'lead_mail'] as const;
export type OutboundApprovalMode = (typeof OUTBOUND_APPROVAL_MODES)[number];

/**
 * The stored setting as a mode. Blank and 'off' are off; 'lead_mail' is on.
 * Anything else — a value written by hand that the API would have refused — is
 * read as ON: whoever wrote it meant to change the default, and the safe side
 * of a misspelt switch is a draft, not a mail.
 */
export function parseOutboundApprovalMode(value: unknown): OutboundApprovalMode {
  if (value === undefined || value === null) return 'off';
  const v = String(value).trim();
  if (v === '' || v === 'off') return 'off';
  return 'lead_mail';
}

/** Can this vertical turn approval on at all? The sales vertical only. */
export function outboundApprovalApplies(caps: readonly VerticalCapability[]): boolean {
  return caps.includes('pipeline') && !caps.includes('mentorship');
}

export type RecipientKind = 'staff' | 'lead' | 'customer' | 'contact' | 'other';

/** Role of a recipient account of THIS org → what the rule calls it. */
export function recipientKindForRole(role: string | null | undefined): RecipientKind {
  if (role === 'ADMIN' || role === 'MENTOR') return 'staff';
  if (role === 'MENTEE') return 'lead';
  if (role === 'COMPANY') return 'customer';
  return 'other';
}

/**
 * What produced a held mail, as a code the outbox renders as a sentence
 * ("Trial or deadline reminder", "Win-back", …). One code per family, not per
 * category: the operator reads a reason, not a taxonomy.
 */
export type OutboundTrigger =
  | 'deadline'
  | 'check_in'
  | 'win_back'
  | 'message'
  | 'meeting'
  | 'pipeline'
  | 'digest'
  | 'content'
  | 'survey'
  | 'request'
  | 'other';

export const OUTBOUND_TRIGGERS: readonly OutboundTrigger[] = [
  'deadline',
  'check_in',
  'win_back',
  'message',
  'meeting',
  'pipeline',
  'digest',
  'content',
  'survey',
  'request',
  'other',
];

type CategoryEntry =
  | { exempt: true; why: string }
  | { exempt: false; trigger: OutboundTrigger; why: string };

const ESSENTIAL = 'account_security group: mail the account cannot function without';

/**
 * Every mail category, explicitly. `exempt: true` leaves even with approval on;
 * `exempt: false` is held when its recipient is not staff.
 */
export const OUTBOUND_CATEGORIES: Readonly<Record<string, CategoryEntry>> = {
  // ── account_security (essential) ──────────────────────────────────────────
  verification: { exempt: true, why: `${ESSENTIAL} — the person asked to verify their address` },
  'password-reset': { exempt: true, why: `${ESSENTIAL} — the person asked for it` },
  invitation: { exempt: true, why: `${ESSENTIAL} — an invitation is how an account starts` },
  account: { exempt: true, why: `${ESSENTIAL} — sign-in links and account changes` },
  security: { exempt: true, why: `${ESSENTIAL} — security notices may never be silenced` },
  'ops-alert': { exempt: true, why: `${ESSENTIAL} — operator alerts go to staff addresses` },
  test: { exempt: true, why: `${ESSENTIAL} — the admin's own test mail` },
  consent: { exempt: true, why: `${ESSENTIAL} — the demo form's double-opt-in confirmation, triggered by the person` },
  'sso-certificate': { exempt: true, why: `${ESSENTIAL} — the IdP certificate-expiry warning, addressed to the org's admins and support address` },
  // ── triggered by the person themselves ────────────────────────────────────
  'mentor-application-received': { exempt: true, why: 'the acknowledgement of the person\'s own application' },
  // #3132: the answer to the person's own bug report, sent only when an admin
  // chooses to AND the person allowed contact. Held like `message` (a human's
  // words to a lead are still the product writing to a lead).
  'support-report-update': { exempt: false, trigger: 'message', why: 'a support-team answer to the person\'s own report' },
  // #3132: a new bug report, to the org's admins — staff mail, never held anyway.
  'support-report': { exempt: false, trigger: 'request', why: 'a new in-app bug report, addressed to the org\'s admins' },
  // ── held although essential-grouped ───────────────────────────────────────
  // The re-consent ask ("keep your data with us?") is a cron the person never
  // triggered, sent to every lead past the retention limit — neither the
  // person's own action nor mail to staff, so in a sales org it waits for an
  // operator like any other automated mail to a lead. Staff still get it at
  // once (the rule never holds mail to staff).
  'retention-reminder': { exempt: false, trigger: 'other', why: 'a cron-driven data-protection re-consent ask, not triggered by the person' },
  // ── held: automated mail about the funnel ─────────────────────────────────
  'stage-deadline': { exempt: false, trigger: 'deadline', why: 'trial and stage deadline reminders' },
  'interaction-reminder': { exempt: false, trigger: 'deadline', why: 'an automated nudge' },
  'weekly-report': { exempt: false, trigger: 'deadline', why: 'an automated nudge' },
  'document-reminder': { exempt: false, trigger: 'deadline', why: 'an automated nudge' },
  // #1859: the account-less reviewer's link, sent when the programme names them.
  'document-review': { exempt: false, trigger: 'request', why: 'a review request to a named external reviewer' },
  'meeting-feedback': { exempt: false, trigger: 'meeting', why: 'the automated "how was it?" ask' },
  'dormant-check-in': { exempt: false, trigger: 'check_in', why: 'the "are you still interested?" mail' },
  nudge: { exempt: false, trigger: 'check_in', why: 'an admin-authored nudge (#1684)' },
  're-engagement': { exempt: false, trigger: 'win_back', why: 'a win-back / re-engagement mail' },
  announcement: { exempt: false, trigger: 'content', why: 'a broadcast' },
  newsletter: { exempt: false, trigger: 'content', why: 'published content' },
  'survey-invite': { exempt: false, trigger: 'survey', why: 'a survey campaign' },
  'unread-digest': { exempt: false, trigger: 'digest', why: 'an automated round-up' },
  'activity-digest': { exempt: false, trigger: 'digest', why: 'an automated round-up' },
  'mentor-digest': { exempt: false, trigger: 'digest', why: 'an automated round-up' },
  'analytics-report': { exempt: false, trigger: 'digest', why: 'an automated report' },
  'program-health': { exempt: false, trigger: 'digest', why: 'an automated report' },
  'company-need-alert': { exempt: false, trigger: 'digest', why: 'an automated match alert' },
  // The mail copy of something a person did in the app. The in-app side is
  // delivered as always; only the e-mail waits, because it is still the product
  // writing to a lead on its own.
  message: { exempt: false, trigger: 'message', why: 'the e-mail copy of an in-app message' },
  'mentor-direct': { exempt: false, trigger: 'message', why: 'the e-mail copy of an in-app message' },
  'meeting-invite': { exempt: false, trigger: 'meeting', why: 'a meeting invitation' },
  'meeting-guest-invite': { exempt: false, trigger: 'meeting', why: 'a meeting invitation to a guest' },
  'meeting-request': { exempt: false, trigger: 'meeting', why: 'a meeting request' },
  'meeting-request-decision': { exempt: false, trigger: 'meeting', why: 'the answer to a meeting request' },
  'meeting-reminder': { exempt: false, trigger: 'meeting', why: 'an automated meeting reminder' },
  'meeting-guest-reminder': { exempt: false, trigger: 'meeting', why: 'an automated meeting reminder' },
  'meeting-series-reminder': { exempt: false, trigger: 'meeting', why: 'an automated meeting reminder' },
  'stage-update': { exempt: false, trigger: 'pipeline', why: 'a stage-change notice' },
  offer: { exempt: false, trigger: 'pipeline', why: 'an offer notice' },
  outcome: { exempt: false, trigger: 'pipeline', why: 'an outcome notice' },
  'mentorship-request': { exempt: false, trigger: 'pipeline', why: 'a relationship notice' },
  'mentorship-decision': { exempt: false, trigger: 'pipeline', why: 'a relationship notice' },
  'mentor-assigned': { exempt: false, trigger: 'pipeline', why: 'an owner-assigned notice' },
  'mentee-assigned': { exempt: false, trigger: 'pipeline', why: 'an owner-assigned notice' },
  'mentor-application': { exempt: false, trigger: 'pipeline', why: 'an application decision' },
  'mentor-offer': { exempt: false, trigger: 'pipeline', why: 'a mentor offering mentorship (#1809), sent only to an opted-in mentee' },
  'goals-evaluation': { exempt: false, trigger: 'pipeline', why: 'an automated evaluation notice' },
  'relation-ending': { exempt: false, trigger: 'pipeline', why: 'the one ending-soon nudge per agreed end date (#1786)' },
  // Inbound requests are addressed to staff in practice (and staff is never
  // held); listed so a copy that does reach a lead waits like everything else.
  'public-contact': { exempt: false, trigger: 'request', why: 'a profile enquiry forwarded by mail' },
  'company-inquiry': { exempt: false, trigger: 'request', why: 'a demo / company enquiry forwarded by mail' },
  'project-join-request': { exempt: false, trigger: 'request', why: 'a join request forwarded by mail' },
};

export function triggerFor(category: string | null | undefined): OutboundTrigger {
  const entry = category ? OUTBOUND_CATEGORIES[category] : undefined;
  return entry && !entry.exempt ? entry.trigger : 'other';
}

export type OutboundDecisionCode =
  | 'approval_off'
  | 'no_org'
  | 'exempt_category'
  | 'staff_recipient'
  | 'held_lead'
  | 'held_customer'
  | 'held_contact'
  | 'held_other';

export interface OutboundDecision {
  hold: boolean;
  code: OutboundDecisionCode;
}

export interface OutboundDecisionInput {
  /** The recipient org's mode, already read through `parseOutboundApprovalMode()`. */
  mode: OutboundApprovalMode;
  /** Whether the recipient org's vertical can hold mail at all (`outboundApprovalApplies`). */
  applies: boolean;
  /** Whether the mail belongs to an organization at all. */
  hasOrg: boolean;
  category: string | null | undefined;
  recipient: RecipientKind;
}

/** The whole decision, in this order: switch, org, category, recipient. */
export function outboundDecision(input: OutboundDecisionInput): OutboundDecision {
  if (!input.applies || input.mode === 'off') return { hold: false, code: 'approval_off' };
  // A mail no organization owns (an operator alert to the server's alert
  // address) has no outbox to wait in.
  if (!input.hasOrg) return { hold: false, code: 'no_org' };
  const entry = input.category ? OUTBOUND_CATEGORIES[input.category] : undefined;
  if (entry?.exempt) return { hold: false, code: 'exempt_category' };
  if (input.recipient === 'staff') return { hold: false, code: 'staff_recipient' };
  // An unknown category falls through to here on purpose: held.
  const code: OutboundDecisionCode =
    input.recipient === 'lead'
      ? 'held_lead'
      : input.recipient === 'customer'
        ? 'held_customer'
        : input.recipient === 'contact'
          ? 'held_contact'
          : 'held_other';
  return { hold: true, code };
}

// ── Draft lifecycle (pure parts) ────────────────────────────────────────────

export const OUTBOUND_DRAFT_STATUSES = ['DRAFT', 'SCHEDULED', 'SENT', 'DISCARDED', 'EXPIRED'] as const;
export type OutboundDraftStatus = (typeof OUTBOUND_DRAFT_STATUSES)[number];

/** A held mail with no deadline of its own waits this long before it expires. */
export const DRAFT_MAX_AGE_DAYS = 14;
/** How far ahead an operator may schedule a draft. */
export const MAX_SCHEDULE_AHEAD_DAYS = 30;
/** Bulk actions take at most this many drafts per request. */
export const OUTBOUND_BULK_MAX = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a held mail expires: the sender's own deadline, capped at the default age. */
export function draftNotAfter(heldAt: Date, senderDeadline?: Date | null): Date {
  const cap = heldAt.getTime() + DRAFT_MAX_AGE_DAYS * DAY_MS;
  const own = senderDeadline instanceof Date && Number.isFinite(senderDeadline.getTime()) ? senderDeadline.getTime() : Infinity;
  return new Date(Math.min(cap, own));
}

export type OutboundAction = 'send' | 'schedule' | 'discard';

export type ActionRefusal = 'not_pending' | 'expired' | 'schedule_in_past' | 'schedule_too_far' | 'schedule_after_expiry';

/**
 * May this action run on a draft in this state? A draft is decided once: only
 * DRAFT moves (a SCHEDULED one is already on the queue, where the mail queue's
 * own cancel withdraws it). `scheduledFor` is checked for schedule only.
 */
export function actionAllowed(
  action: OutboundAction,
  draft: { status: OutboundDraftStatus; notAfter: Date },
  now: Date,
  scheduledFor?: Date | null,
): true | ActionRefusal {
  if (draft.status !== 'DRAFT') return 'not_pending';
  if (action === 'discard') return true;
  if (draft.notAfter.getTime() <= now.getTime()) return 'expired';
  if (action === 'schedule') {
    const at = scheduledFor?.getTime();
    if (at === undefined || !Number.isFinite(at) || at <= now.getTime()) return 'schedule_in_past';
    if (at > now.getTime() + MAX_SCHEDULE_AHEAD_DAYS * DAY_MS) return 'schedule_too_far';
    if (at >= draft.notAfter.getTime()) return 'schedule_after_expiry';
  }
  return true;
}

/** The status an allowed action writes. */
export function statusAfter(action: OutboundAction): OutboundDraftStatus {
  return action === 'send' ? 'SENT' : action === 'schedule' ? 'SCHEDULED' : 'DISCARDED';
}

/**
 * The address as the list shows it: the first letter of the local part and the
 * domain — enough to tell two drafts apart, not enough to copy an address out of
 * a screenshot. The preview shows the full one, to whoever may open it.
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return `${local[0]}***@${domain}`;
}
