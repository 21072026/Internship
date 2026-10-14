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

const CONTROL_CHARS = /\p{Cc}/u;

/**
 * The account's id in the source system, as the CRM stores and matches it:
 * trimmed, lower-cased, 1–191 characters, no control characters. Opaque — its
 * shape is the sender's business. Null when nothing valid is left.
 */
export function normalizeExternalId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v.length === 0 || v.length > EXTERNAL_ID_MAX || CONTROL_CHARS.test(v)) return null;
  return v;
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

/** The person on the event, "First Last", or ''. */
export function contactFullName(contact: EventContact | null | undefined): string {
  return [contact?.first_name, contact?.last_name].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
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
 * The trial window a record gets from an event. The source computes the dates
 * and the CRM does not recompute them, but a date the record already carries
 * is never overwritten — the first window is the one that was agreed.
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
