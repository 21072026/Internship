// What an account event from a registered machine source means for the CRM
// (#2450/#2451, one generic route since #2914) — the rule, dependency-free.
// The public contract is docs/integrations/account-events.md; the Prisma half
// is src/lib/accountEventIngest.ts, the envelope's validation
// src/lib/accountEventSchema.ts, and the source registry
// src/lib/integrationSources.ts.
//
// Only three event types act on the funnel:
//   account_created, trial_started → TRIAL_ACTIVE
//   converted                      → DEAL_WON
// Every other type is recorded (IntegrationEvent + an activity entry) and moves
// nothing — a mapping for it is a product decision, not a side effect of a
// sender adding a field. An unknown type is refused at the schema.
//
// The source itself is DATA: `IntegrationSource` rows a tenant's operator
// registers (prisma/register-integration-source.mjs). The code names no
// source; it only knows what a valid slug looks like.
//
// Unit-tested in scripts/test/account-event-rule.test.mjs.
import { ACQUISITION_SOURCES } from './leadSourceName';
import { TEXT_LIMITS } from './textLimits';
import {
  TRIAL_ACTIVE_STAGE_KEY,
  TRIAL_EXPIRED_STAGE_KEY,
  daysUntilUtcDay,
  decisionWindowEndsAt,
} from './trialReminderRule';

/** The envelope version this code understands; anything else is refused. */
export const ACCOUNT_EVENT_SCHEMA_VERSION = 1;

export const ACCOUNT_EVENT_TYPES = [
  'account_created',
  'trial_started',
  'commitment_confirmed',
  'converted',
  'plan_changed',
  'deactivated',
  'cancellation_requested',
  'cancelled',
  'reactivated',
  'out_of_scope',
  'deleted',
] as const;
export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number];

/** The self-reported sign-up channel — the same list the lead-source rule reads. */
export const ACCOUNT_ACQUISITION_SOURCES = ACQUISITION_SOURCES;

/**
 * The sender's own id for one event: opaque, at most 64 characters (the
 * `IntegrationEvent.eventId` column), and stored lower-cased — ids are
 * case-insensitive under the column's collation anyway, so `A1` and `a1` are
 * one event and saying so up front beats a surprise duplicate.
 */
export const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** `Company.externalId` / `IntegrationEvent.externalId` are VarChar(191). */
export const EXTERNAL_ID_MAX = 191;

/**
 * Printable ASCII, U+0020–U+007E. The id columns compare under the database's
 * case- AND accent-insensitive collation (`café` = `cafe`, `straße` =
 * `strasse`), so a non-ASCII id could silently match a different account.
 * Inside ASCII the only folding left is letter case, which the CRM applies
 * itself by lower-casing — a match is then exactly the string it stored.
 */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

/**
 * The account's id in the source system, as the CRM stores and matches it:
 * trimmed, 1–191 characters of printable ASCII, lower-cased. Otherwise opaque —
 * its shape is the sender's business. Null when nothing valid is left.
 * Checked BEFORE lower-casing, so a non-ASCII letter that lower-cases to an
 * ASCII one (the Kelvin sign → `k`) is refused rather than folded.
 */
export function normalizeExternalId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > EXTERNAL_ID_MAX || !PRINTABLE_ASCII.test(v)) return null;
  return v.toLowerCase();
}

/**
 * What a source's slug looks like: lower-case letters, digits and dashes, 2–40
 * characters (`IntegrationSource.slug` is VarChar(40)), starting with a letter
 * or digit. It is the `[source]` URL segment and `IntegrationEvent.provider`.
 */
export const SOURCE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

/**
 * The static siblings of `[source]` under src/app/api/integrations/. A source
 * named like one would share its URL prefix with a different feature, so no
 * source may be registered under these names. The unit test reads the
 * directory and fails when a new static sibling is not listed here.
 */
export const RESERVED_SOURCE_SLUGS = ['calendar', 'google'] as const;

/** `IntegrationSource.label` is VarChar(80). */
export const SOURCE_LABEL_MAX = 80;

/**
 * The slug a request or an operator named, lower-cased, or null when it is not
 * one a source could ever be registered under (malformed or reserved). The
 * route answers null with the same 404 as an unregistered slug.
 */
export function normalizeSourceSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const slug = raw.toLowerCase();
  if (!SOURCE_SLUG_PATTERN.test(slug)) return null;
  if ((RESERVED_SOURCE_SLUGS as readonly string[]).includes(slug)) return null;
  return slug;
}

/** A label as an operator typed it: whitespace collapsed, capped, or null. */
export function normalizeSourceLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, SOURCE_LABEL_MAX).trim();
  return v || null;
}

export type IngestIntent =
  | { kind: 'open_trial'; toStage: 'TRIAL_ACTIVE' }
  | { kind: 'won'; toStage: 'DEAL_WON' }
  | { kind: 'record' };

export function ingestIntent(eventType: AccountEventType): IngestIntent {
  switch (eventType) {
    case 'account_created':
    case 'trial_started':
      return { kind: 'open_trial', toStage: 'TRIAL_ACTIVE' };
    case 'converted':
      return { kind: 'won', toStage: 'DEAL_WON' };
    default:
      return { kind: 'record' };
  }
}

export interface EventContact {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  company_name?: string | null;
}

/** `Company.contactName` — VarChar(191), the same cap the import validator applies. */
export const CONTACT_NAME_MAX = TEXT_LIMITS.companyContactName;

/**
 * The person on the event, "First Last", or ''. Capped at `Company.contactName`:
 * each part may be 191 characters on its own, and a joined name past the column
 * would turn a valid event into a permanent `conflict` (a new account) or a
 * failed write (gap-filling an existing one).
 */
export function contactFullName(contact: EventContact | null | undefined): string {
  const full = [contact?.first_name, contact?.last_name].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
  return full.slice(0, CONTACT_NAME_MAX).trim();
}

/** `Company.name` is VarChar(191). */
export const ACCOUNT_NAME_MAX = 191;

/**
 * The name a NEW account is created under: the company name, else the
 * person's, else a placeholder naming the source and the account's id there
 * (`<source label> <external id>`) — an operator renames it, and the feed never
 * overwrites a name once it is there (gap-fill only). Capped at the column
 * width: a long label plus a long id must not fail the write.
 */
export function accountNameFor(
  externalId: string,
  contact: EventContact | null | undefined,
  sourceLabel: string,
): string {
  const name = contact?.company_name?.trim() || contactFullName(contact) || `${sourceLabel.trim()} ${externalId}`.trim();
  return name.slice(0, ACCOUNT_NAME_MAX).trim();
}

export interface TrialDates {
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
}

/**
 * The trial window a record gets from an event. The event's own dates are
 * taken as sent, but a date the record already carries is never overwritten —
 * the first window is the one that was agreed.
 * `fallback` is what the CRM's own rule (`trialWindowFor`, #2551) would stamp;
 * it fills only what neither the record nor the event provides.
 */
export function ingestTrialWindow(existing: TrialDates, event: TrialDates, fallback: Partial<TrialDates>): Partial<TrialDates> {
  const out: Partial<TrialDates> = {};
  if (!existing.trialStartedAt) {
    const start = event.trialStartedAt ?? fallback.trialStartedAt ?? null;
    if (start) out.trialStartedAt = start;
  }
  if (!existing.trialEndsAt) {
    const end = event.trialEndsAt ?? fallback.trialEndsAt ?? null;
    if (end) out.trialEndsAt = end;
  }
  return out;
}

/**
 * The account's high-water mark: an event older than the newest event already
 * APPLIED for the same account changes no state (it carries a stale snapshot).
 */
export function isStaleEvent(occurredAt: Date, newestAppliedAt: Date | null): boolean {
  return !!newestAppliedAt && occurredAt.getTime() < newestAppliedAt.getTime();
}

// ── Historic mode ────────────────────────────────────────────────────────────
//
// A source that connects to the CRM after years of its own history replays that
// history through the same endpoint. Those events describe things that already
// happened: a trial that ran out two years ago must land as an expired trial
// dated two years ago, and nobody may be reminded, rung or mailed about it.
// An event is HISTORIC when the sender says so (`replay: true`) or when it is
// older than HISTORIC_EVENT_AGE_DAYS — a live feed delivers within minutes, and
// one that parked a 404 for a day or two still counts as live.
// docs/integrations/account-events.md § Historic mode is the contract.

/** An event older than this many days is historic even without `replay: true`. */
export const HISTORIC_EVENT_AGE_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Does this event replay the past (true) or report the present (false)?
 * Strictly older than the threshold; an event dated in the future is live.
 */
export function isHistoricEvent(occurredAt: Date, now: Date, replayFlag: boolean | null | undefined): boolean {
  if (replayFlag === true) return true;
  return now.getTime() - occurredAt.getTime() > HISTORIC_EVENT_AGE_DAYS * MS_PER_DAY;
}

/**
 * The moment a historic write is dated with: the event's own `occurred_at`,
 * never later than `now` (a clock-skewed sender must not date history in the
 * future). A live event gets undefined — its rows are dated by the database
 * exactly as before historic mode existed.
 */
export function backdateFor(historic: boolean, occurredAt: Date, now: Date): Date | undefined {
  if (!historic) return undefined;
  return occurredAt.getTime() > now.getTime() ? now : occurredAt;
}

export interface HistoricTrialLanding {
  /** Move the record from TRIAL_ACTIVE to TRIAL_EXPIRED as part of the replay. */
  expire: boolean;
  /** The expiry's history row is dated here (null when `expire` is false). */
  expiredAt: Date | null;
  /**
   * The decision window of the expired trial has already closed: claim its one
   * bell up front, so the daily sweep never rings about a window that shut
   * long ago.
   */
  preclaimDecisionWindow: boolean;
}

/**
 * Where a historic trial record lands once its window is known. The same
 * calendar-day rule as the daily expiry (`expireTrials`,
 * src/lib/jobs/trialReminders.ts): a trial whose last day is before today
 * (UTC) has run out. The expiry is dated at the trial's end — never before the
 * moment the record entered the trial (`enteredAt`), so the history stays in
 * order even when a source sends an end before its start.
 */
export function historicTrialLanding(input: {
  pipelineStatus: string;
  trialEndsAt: Date | null;
  enteredAt: Date;
  now: Date;
  decisionWindowDays: number;
}): HistoricTrialLanding {
  const { trialEndsAt, now } = input;
  if (!trialEndsAt) return { expire: false, expiredAt: null, preclaimDecisionWindow: false };
  const expire = input.pipelineStatus === TRIAL_ACTIVE_STAGE_KEY && daysUntilUtcDay(trialEndsAt, now) < 0;
  const expired = expire || input.pipelineStatus === TRIAL_EXPIRED_STAGE_KEY;
  const closes = decisionWindowEndsAt(trialEndsAt, input.decisionWindowDays);
  return {
    expire,
    expiredAt: expire ? new Date(Math.max(trialEndsAt.getTime(), input.enteredAt.getTime())) : null,
    preclaimDecisionWindow: expired && !!closes && closes.getTime() <= now.getTime(),
  };
}
