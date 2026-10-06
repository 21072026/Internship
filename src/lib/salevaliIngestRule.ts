// What a SaleVali account event means for the CRM (#2450/#2451) — the rule,
// dependency-free. The contract it implements is
// docs/marketing-vertical/salevali-provider-contract.md (§ Olay zarfı, § Olay
// türleri, § CRM'de alan eşlemesi); the Prisma half is src/lib/salevaliIngest.ts.
//
// Only the DECIDED mappings act on the funnel:
//   account_created, trial_started → TRIAL_ACTIVE (#2450's acceptance)
//   converted                      → DEAL_WON     (billing starts there)
// Every other event type is recorded and moves nothing until its open decision
// is taken (K-5 upgrade_confirmed, K-6 passivated's reason code, #2572 for the
// post-won customer states). An unknown type is refused at the schema.
//
// Unit-tested in scripts/test/salevali-ingest-rule.test.mjs.

export const SALEVALI_PROVIDER = 'salevali';

export const SALEVALI_EVENT_TYPES = [
  'account_created',
  'trial_started',
  'upgrade_confirmed',
  'converted',
  'license_changed',
  'passivated',
  'cancellation_requested',
  'cancelled',
  'reactivated',
  'excluded',
  'deleted',
] as const;
export type SaleValiEventType = (typeof SALEVALI_EVENT_TYPES)[number];

export const SALEVALI_ACQUISITION_SOURCES = [
  'search_engine',
  'social_media',
  'youtube',
  'referral',
  'advertisement',
  'other',
] as const;

/** K-1: the key is SaleVali `User._id`, 24 lower-case hex. */
export const EXTERNAL_ID_PATTERN = /^[0-9a-f]{24}$/;

export type IngestIntent =
  | { kind: 'open_trial'; toStage: 'TRIAL_ACTIVE' }
  | { kind: 'won'; toStage: 'DEAL_WON' }
  | { kind: 'record' };

export function ingestIntent(eventType: SaleValiEventType): IngestIntent {
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
  name?: string | null;
  surname?: string | null;
  email?: string | null;
  company_name?: string | null;
}

/** The person on the event, "Name Surname", or ''. */
export function contactFullName(contact: EventContact | null | undefined): string {
  return [contact?.name, contact?.surname].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
}

/**
 * The name a NEW account is created under: the company name, else the
 * person's, else a placeholder naming the SaleVali id — an operator renames it,
 * and the feed never overwrites a name once it is there (gap-fill only).
 */
export function accountNameFor(externalId: string, contact: EventContact | null | undefined): string {
  return contact?.company_name?.trim() || contactFullName(contact) || `SaleVali ${externalId}`;
}

export interface TrialDates {
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
}

/**
 * The trial window a record gets from an event. SaleVali computes the dates and
 * the CRM does not recompute them (the contract), but a date the record already
 * carries is never overwritten — the first window was agreed with the customer.
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
