// What an account event from a registered machine source means for the CRM
// (#2450/#2451, one generic route since #2914) — the rule, dependency-free.
// The public contract is docs/integrations/account-events.md; the Prisma half
// is src/lib/accountEventIngest.ts, the envelope's validation
// src/lib/accountEventSchema.ts, and the source registry
// src/lib/integrationSources.ts.
//
// What acts on the funnel (`ingestIntent`, then `planAccountEvent` against the
// record's current stage — the whole table is in the contract and unit-tested):
//   account_created, trial_started → TRIAL_ACTIVE (a re-trial after an ended
//                                    trial, a loss or a closed record is a
//                                    new journey through win-back)
//   converted                      → DEAL_WON (on a lost record: win-back)
//   cancelled, deactivated         → DEAL_LOST, with a drop-off reason (#2966)
//   reactivated                    → on a lost record: win-back
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
import { isBackwardMove, type StageForDirection } from './stageDirection';
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
export const RESERVED_SOURCE_SLUGS = ['calendar', 'chat', 'google', 'microsoft'] as const;

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

export const WON_STAGE_KEY = 'DEAL_WON';
export const LOST_STAGE_KEY = 'DEAL_LOST';

export type IngestIntent =
  | { kind: 'open_trial'; toStage: 'TRIAL_ACTIVE' }
  | { kind: 'won'; toStage: 'DEAL_WON' }
  | { kind: 'lost'; toStage: 'DEAL_LOST' }
  | { kind: 'reactivate' }
  | { kind: 'record' };

export function ingestIntent(eventType: AccountEventType): IngestIntent {
  switch (eventType) {
    case 'account_created':
    case 'trial_started':
      return { kind: 'open_trial', toStage: 'TRIAL_ACTIVE' };
    case 'converted':
      return { kind: 'won', toStage: 'DEAL_WON' };
    case 'cancelled':
    case 'deactivated':
      return { kind: 'lost', toStage: 'DEAL_LOST' };
    case 'reactivated':
      return { kind: 'reactivate' };
    default:
      return { kind: 'record' };
  }
}

/**
 * The drop-off reason a lost move from the feed carries (#2966). A customer
 * who had signed (the record reached DEAL_WON) and left is the vocabulary's
 * own CUSTOMER_CANCELLED (src/lib/dropoffReasons.ts); anything else ended
 * before it was ever won, and is OTHER with a fixed note naming the source.
 */
export function lostReasonFor(wasWon: boolean, sourceSlug: string): { reasonCode: string; reasonNote: string | null } {
  return wasWon
    ? { reasonCode: 'CUSTOMER_CANCELLED', reasonNote: null }
    : { reasonCode: 'OTHER', reasonNote: `${sourceSlug}: ended during trial` };
}

/** The record an event acts on, as much of it as the plan needs. */
export interface PlanRecord {
  /** `MentorshipRelation.status`: ACTIVE, or closed (COMPLETED …). */
  status: string;
  pipelineStatus: string;
  /** The record is at DEAL_WON, or its history shows it reached DEAL_WON. */
  wasWon: boolean;
  trialEndsAt: Date | null;
}

/**
 * What one event does to one existing funnel record. `move` is an in-place
 * stage move; `win_back` opens a NEW journey through the one win-back writer
 * (src/lib/winBack.ts), chained by `previousRelationId`; `refused_backward`
 * is logged and changes nothing; `nothing` is answered `recorded` with its
 * detail; `missing_stage` is a `conflict` (the org has no such stage).
 */
export type EventPlan =
  | { kind: 'move'; toStage: string; reasonCode?: string; reasonNote?: string | null }
  | { kind: 'win_back'; toStage: 'TRIAL_ACTIVE' | 'DEAL_WON'; predecessorClosed: boolean }
  | { kind: 'refused_backward'; toStage: string }
  | { kind: 'nothing'; detail: string }
  | { kind: 'missing_stage'; stage: string };

/**
 * The event table (docs/integrations/account-events.md § Event types). Pure:
 * the writer reads the record and the org's stages, this decides.
 *
 * A record has ENDED when it is closed (not ACTIVE) or sits on an off-path
 * stage (lost). An ended record is never reopened in place: a new trial, a
 * conversion of a lost customer or a reactivation opens a new journey. An
 * expired trial is not ended — a `converted` moves it on in place — but a new
 * trial for it is a new journey too, as long as the event comes after the
 * trial's end: a trial event from inside the old window belongs to the trial
 * that already ran, and is refused as a backward move exactly as before.
 */
export function planAccountEvent(input: {
  intent: Exclude<IngestIntent, { kind: 'record' }>;
  record: PlanRecord;
  stages: readonly StageForDirection[];
  occurredAt: Date;
  sourceSlug: string;
}): EventPlan {
  const { intent, record, stages } = input;
  const has = (key: string) => stages.some((s) => s.key === key);
  const current = stages.find((s) => s.key === record.pipelineStatus);
  const closed = record.status !== 'ACTIVE';
  const lost = !!current?.isOffPath;
  const ended = closed || lost;
  const winBack = (toStage: 'TRIAL_ACTIVE' | 'DEAL_WON'): EventPlan =>
    has(toStage) ? { kind: 'win_back', toStage, predecessorClosed: closed } : { kind: 'missing_stage', stage: toStage };
  const move = (toStage: string, extra: { reasonCode?: string; reasonNote?: string | null } = {}): EventPlan => {
    if (!has(toStage)) return { kind: 'missing_stage', stage: toStage };
    if (isBackwardMove(stages, record.pipelineStatus, toStage)) return { kind: 'refused_backward', toStage };
    return { kind: 'move', toStage, ...extra };
  };

  switch (intent.kind) {
    case 'open_trial': {
      if (ended) return winBack(TRIAL_ACTIVE_STAGE_KEY);
      const afterTrial = !record.trialEndsAt || input.occurredAt.getTime() > record.trialEndsAt.getTime();
      if (record.pipelineStatus === TRIAL_EXPIRED_STAGE_KEY && afterTrial) return winBack(TRIAL_ACTIVE_STAGE_KEY);
      return move(intent.toStage);
    }
    case 'won':
      if (lost) return winBack(WON_STAGE_KEY);
      if (closed) return { kind: 'refused_backward', toStage: intent.toStage };
      return move(intent.toStage);
    case 'lost': {
      if (ended) return { kind: 'nothing', detail: `${record.pipelineStatus}: the record has already ended` };
      return move(intent.toStage, lostReasonFor(record.wasWon, input.sourceSlug));
    }
    case 'reactivate':
      if (!lost) return { kind: 'nothing', detail: `${record.pipelineStatus}: not lost, nothing to reactivate` };
      return winBack(record.wasWon ? WON_STAGE_KEY : TRIAL_ACTIVE_STAGE_KEY);
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
 * The smallest step that keeps two history rows apart: Prisma's DateTime is a
 * DATETIME(3), so one millisecond is what the column can still tell apart.
 */
export const HISTORY_STEP_MS = 1;

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
    // Strictly after the entry: a source that sends an end at or before its
    // start must not tie the expiry with the move into the trial, or a reader
    // ordering by createdAt alone could show the expiry first.
    expiredAt: expire ? new Date(Math.max(trialEndsAt.getTime(), input.enteredAt.getTime() + HISTORY_STEP_MS)) : null,
    preclaimDecisionWindow: expired && !!closes && closes.getTime() <= now.getTime(),
  };
}

/**
 * The moment a historic move of ONE record is dated: the event's own moment,
 * but never before the record's start and never at or before the newest row
 * already in its history. The out-of-order guard (`isStaleEvent`) only knows
 * the feed's own earlier events; a person's move from today, or the import's,
 * is history the replay must not slide underneath — every "last move" reader
 * (the stage clock, the board's ordering, the timeline) reads the newest row.
 * A replay into a record somebody already worked on lands right after that
 * work, which is the earliest moment the record could truly have made the move.
 */
export function historicMoveAt(at: Date, record: { startDate: Date | null; newestHistoryAt: Date | null }): Date {
  let t = at.getTime();
  if (record.startDate) t = Math.max(t, record.startDate.getTime());
  if (record.newestHistoryAt) t = Math.max(t, record.newestHistoryAt.getTime() + HISTORY_STEP_MS);
  return new Date(t);
}

/** The newest history row of a record, as the undo rule needs to see it. */
export interface HistoryRowLike {
  fromStatus: string;
  toStatus: string;
  changedById: string | null;
  createdAt: Date;
}

/**
 * Should a historic move first take back the record's system expiry?
 *
 * The replay expires a trial as soon as the trial's own event is applied
 * (`historicTrialLanding`), looking at today's date — it cannot know what the
 * replay says next. When the next event is a move that happened BEFORE that
 * expiry (a customer who paid during the trial), the expiry never happened:
 * the record goes on from TRIAL_ACTIVE, and the expiry row is removed rather
 * than left as a "TRIAL_EXPIRED → DEAL_WON" dated before the expiry itself.
 *
 * Only ever the system's own expiry (`changedById` null, TRIAL_ACTIVE →
 * TRIAL_EXPIRED), only when it is the newest row of the record, and only when
 * it is dated after the event — anything a person did is never touched.
 */
export function shouldUndoHistoricExpiry(input: {
  pipelineStatus: string;
  toStage: string;
  at: Date;
  newest: HistoryRowLike | null;
}): boolean {
  const { newest } = input;
  if (input.pipelineStatus !== TRIAL_EXPIRED_STAGE_KEY) return false;
  if (input.toStage === TRIAL_ACTIVE_STAGE_KEY || input.toStage === TRIAL_EXPIRED_STAGE_KEY) return false;
  if (!newest || newest.changedById !== null) return false;
  if (newest.fromStatus !== TRIAL_ACTIVE_STAGE_KEY || newest.toStatus !== TRIAL_EXPIRED_STAGE_KEY) return false;
  return newest.createdAt.getTime() > input.at.getTime();
}

// ── The batch (#2966) ────────────────────────────────────────────────────────

/** The most events one batch request may carry (docs/integrations/account-events.md § Batch). */
export const ACCOUNT_EVENT_BATCH_MAX = 200;

/**
 * The order a batch is processed in: by external id, then by when each event
 * happened, then as sent — the order a replay must be applied in, whatever
 * order the sender listed it. Returns the events' indexes. Ids compare as the
 * stored, lower-cased ASCII strings they are (no locale collation).
 */
export function batchOrder(events: readonly { external_id: string; occurred_at: Date }[]): number[] {
  return events
    .map((e, index) => ({ key: e.external_id, at: e.occurred_at.getTime(), index }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.at - b.at || a.index - b.index))
    .map((e) => e.index);
}

/**
 * The stages a replay writes into (docs/integrations/account-events.md
 * § Batch): a trial, its expiry, a conversion and a loss. A batch is refused up
 * front (409 `missing_stages`) when the org lacks any of them, BEFORE anything
 * is claimed: a history replayed before the org's funnel is ready (an org
 * still on an older stage set) is a configuration gap to fix first, not two
 * hundred per-event conflicts to read through.
 */
export const REPLAY_STAGE_KEYS = [TRIAL_ACTIVE_STAGE_KEY, TRIAL_EXPIRED_STAGE_KEY, WON_STAGE_KEY, LOST_STAGE_KEY] as const;

/** The replay stages the org's funnel lacks, in REPLAY_STAGE_KEYS order (empty = ready). */
export function missingReplayStages(stages: readonly { key: string }[]): string[] {
  const keys = new Set(stages.map((s) => s.key));
  return REPLAY_STAGE_KEYS.filter((k) => !keys.has(k));
}
