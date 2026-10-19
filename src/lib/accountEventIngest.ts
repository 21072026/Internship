// The account-event writer (#2450/#2451, generic since #2914) — the Prisma
// half. The rule is src/lib/accountEventRule.ts; the public contract is
// docs/integrations/account-events.md. The source is a registered
// `IntegrationSource` row (src/lib/integrationSources.ts): its slug is the
// `provider` every claim and high-water mark is keyed on, its label names a
// placeholder account. Push (the route) and a future pull job call the SAME
// function — only the caller differs.
//
// ONE EVENT, ONCE. An `IntegrationEvent` row is inserted FIRST and its unique
// index (orgId, provider, eventId) is the claim — the CompanyInquiry
// conditional-claim pattern: a repeated event_id writes nothing. A claim left
// `processing` by a crashed run is taken over after CLAIM_STALE_MS; a run that
// throws releases its claim so the source can retry.
//
// NEVER BACKWARDS. Every stage move goes through `isBackwardMove`
// (src/lib/stageChange.ts) — a machine never drags a record to an earlier
// stage, and a refused move is logged, not swallowed. What an event does to a
// record is decided by ONE pure table, `planAccountEvent`
// (src/lib/accountEventRule.ts). A lost (off-path) or closed record is never
// reopened: a new trial, a `converted` or a `reactivated` opens a NEW journey
// chained by `previousRelationId` through the one win-back writer,
// `winBack()` (src/lib/winBack.ts), and the old record stays as it ended.
//
// ONE ACCOUNT NAMESPACE PER ORG. The claim and the high-water mark are kept per
// source, but the account is matched on `Company.externalId` inside the org,
// whichever source sent the event: two sources of one org that use the same id
// for different accounts would act on one Company. The contract says so and the
// operator CLI warns when a second enabled source joins an org; scoping the
// match by source would need a source column on Company (an expand step).
//
// A FUNNEL RECORD NEEDS A PERSON. A new account is placed on the funnel only
// when the event carries `contact.email` (the record's lead is a person, see
// planFunnel in src/lib/marketingImport.ts); without one the account is created
// alone and the answer says so in `detail`.
//
// NOT AUTHORITATIVE. On an existing account the feed only fills gaps
// (`planFieldUpdates`, authoritative: false); an operator's edit is never
// overwritten. It never writes a marketing permission: a new account gets the
// machine NONE row and nothing else (#2577).
//
// LIVE MOVES ARE MOVES (#2966). A live (non-historic) stage move goes through
// the shared stage write path, `recordStageMove()` (src/lib/stageMove.ts): the
// history row, the `pipeline.stage_change` activity line, the stage SLA, the
// owner's bell and the webhook — exactly what a person's move of the card does
// (the lead itself is never told: a MARKETING org has no portal, see
// emitStageChange). A HISTORIC move stays silent: its history row is written
// here, backdated, and nothing else.
//
// ONE WRITER, ANY HANDLE. Every read and write goes through `ctx.db`
// (src/lib/dbHandle.ts) — the root client, or the transaction the batch's dry
// run rolls back (`ingestAccountEventBatch`): a dry run is this same call with
// a writer that does not write.
//
// HISTORIC MODE (docs/integrations/account-events.md § Historic mode). An event
// the sender marks `replay: true`, or one older than HISTORIC_EVENT_AGE_DAYS,
// describes the past, and is written as the past: every row it creates or moves
// is dated at `occurred_at` (`backdateFor`), a trial that has already run out
// lands at TRIAL_EXPIRED with a history row dated at its end, a decision window
// that has already closed is claimed up front so the daily sweep never rings
// it, and the per-event activity lines fold into ONE aggregated line per
// request (`ReplayLog`). A live event is written exactly as before.
// Two guards keep a record's history in order: a historic move is never dated
// at or before the newest row the record already has (`historicMoveAt` — a
// person's move from today stays the newest), and a move that happened before
// the replay's own eager expiry takes that expiry back first
// (`shouldUndoHistoricExpiry` — a customer who paid during the trial never
// expired).
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { inTransaction, type Db } from '@/lib/dbHandle';
import { runWithOrg } from '@/lib/orgContext';
import { orgWhere, withinTenant } from '@/lib/tenantFilter';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { statusChangeData, validateDropoffReason } from '@/lib/stageChange';
import { recordStageMove } from '@/lib/stageMove';
import { winBack, WinBackConflictError } from '@/lib/winBack';
import { AlreadyMentoredError } from '@/lib/activeMentorship';
import { findOrCreateSource } from '@/lib/leadSource';
import {
  DECISION_WINDOW_CLAIM,
  TRIAL_ACTIVE_STAGE_KEY,
  TRIAL_EXPIRED_STAGE_KEY,
  trialWindowFor,
} from '@/lib/trialReminderRule';
import { decisionWindowDaysFor, trialLengthDaysFor } from '@/lib/trialWindow';
import { planFieldUpdates } from '@/lib/externalSyncPolicy';
import { resolveDefaultLeadOwner } from '@/lib/leadOwner';
import { createMarketingAccount } from '@/lib/marketingImportStore';
import { recordMachineContactPermission } from '@/lib/contactPermission';
import { leadSourceName } from '@/lib/leadSourceName';
import { logActivity, type ActivityInput } from '@/lib/activity';
import {
  accountNameFor,
  backdateFor,
  contactFullName,
  historicMoveAt,
  historicTrialLanding,
  ingestIntent,
  ingestTrialWindow,
  isHistoricEvent,
  isStaleEvent,
  planAccountEvent,
  shouldUndoHistoricExpiry,
  batchOrder,
  WON_STAGE_KEY,
  type EventPlan,
  type IngestIntent,
} from '@/lib/accountEventRule';
import type { AccountEvent } from '@/lib/accountEventSchema';

/** A `processing` claim older than this belongs to a run that died. */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

/** The `detail` of a new account created without a funnel record. */
export const NO_FUNNEL_RECORD_CREATED =
  "account created without a funnel record (a record needs the contact's e-mail); an operator places it on the funnel";

/** The one aggregated activity line a historic request writes. */
export const REPLAY_ACTIVITY_ACTION = 'integration.replay';

export type IngestOutcome =
  | 'applied'
  | 'duplicate'
  | 'stale'
  | 'refused_backward'
  | 'recorded'
  | 'unknown_account'
  | 'conflict'
  | 'no_default_owner';

export interface IngestResult {
  outcome: IngestOutcome;
  companyId?: string;
  relationId?: string;
  detail?: string;
  /** Present (true) when the event was handled in historic mode. */
  historic?: true;
}

type Stages = Awaited<ReturnType<typeof resolvePipelineStages>>;

/** What the writer needs to know about the source: its key and its name. */
export interface EventSource {
  slug: string;
  label: string;
}

/**
 * What the historic events of one request did, folded into one activity line.
 * A caller handling several events in one request (a batch) passes one log to
 * every call and flushes it once; a single call makes and flushes its own.
 */
export interface ReplayLog {
  events: number;
  tally: Record<string, number>;
}

export function newReplayLog(): ReplayLog {
  return { events: 0, tally: {} };
}

/** Write the log's one activity line — nothing when no historic event was handled. */
export async function flushReplayLog(orgId: string, source: EventSource, log: ReplayLog): Promise<void> {
  if (log.events === 0) return;
  const parts = Object.entries(log.tally)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, n]) => `${key}=${n}`)
    .join(' ');
  await runWithOrg(orgId, () =>
    logActivity({
      action: REPLAY_ACTIVITY_ACTION,
      orgId,
      targetType: 'IntegrationSource',
      targetId: source.slug,
      detail: `${source.slug}: ${log.events} historic event(s): ${parts}`.slice(0, 1000),
    }),
  );
}

export interface IngestOptions {
  /** The wall clock; injectable so a test can place the request anywhere. */
  now?: Date;
  /** Share one aggregated activity line across several events (see ReplayLog). */
  replayLog?: ReplayLog;
  /** The handle every read and write goes through; omitted = the root client. */
  db?: Db;
}

/** One event's write context: who, what, and whether it replays the past. */
interface Ctx {
  orgId: string;
  source: EventSource;
  event: AccountEvent;
  now: Date;
  historic: boolean;
  /** The moment historic rows are dated; undefined for a live event. */
  at: Date | undefined;
  log: ReplayLog | null;
  db: Db;
}

const RELATION_SELECT = {
  id: true,
  status: true,
  pipelineStatus: true,
  mentorId: true,
  menteeId: true,
  companyId: true,
  trialStartedAt: true,
  trialEndsAt: true,
  startDate: true,
} as const;
type RelationRow = Prisma.MentorshipRelationGetPayload<{ select: typeof RELATION_SELECT }>;

export async function ingestAccountEvent(
  orgId: string,
  source: EventSource,
  event: AccountEvent,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const now = options.now ?? new Date();
  const historic = isHistoricEvent(event.occurred_at, now, event.replay);
  const ownLog = historic && !options.replayLog ? newReplayLog() : null;
  const ctx: Ctx = {
    orgId,
    source,
    event,
    now,
    historic,
    at: backdateFor(historic, event.occurred_at, now),
    log: historic ? (options.replayLog ?? ownLog) : null,
    db: options.db ?? prisma,
  };
  const result = await runWithOrg(orgId, () => ingestOne(ctx));
  if (!historic) return result;
  if (ctx.log && result.outcome !== 'duplicate' && result.outcome !== 'no_default_owner') {
    ctx.log.events += 1;
    tally(ctx, result.outcome);
  }
  if (ownLog) await flushReplayLog(orgId, source, ownLog);
  return { ...result, historic: true };
}

async function ingestOne(ctx: Ctx): Promise<IngestResult> {
  const { orgId, source, event, db } = ctx;
  const claimId = await claim(db, orgId, source, event);
  if (!claimId) return { outcome: 'duplicate' };
  let result: IngestResult;
  try {
    result = await apply(ctx);
  } catch (e) {
    await db.integrationEvent.delete({ where: { id: claimId } }).catch(() => {});
    throw e;
  }
  if (result.outcome === 'no_default_owner') {
    // Retryable: nothing was written, and the org's setting is what is missing.
    await db.integrationEvent.delete({ where: { id: claimId } });
    return result;
  }
  await db.integrationEvent.update({
    where: { id: claimId },
    data: { outcome: result.outcome, companyId: result.companyId ?? null, detail: result.detail?.slice(0, 500) ?? null },
  });
  return result;
}

function tally(ctx: Ctx, key: string): void {
  if (ctx.log) ctx.log.tally[key] = (ctx.log.tally[key] ?? 0) + 1;
}

/**
 * An activity line of the ingest: written as it always was for a live event;
 * counted into the request's one aggregated line for a historic one.
 */
async function note(ctx: Ctx, entry: ActivityInput & { action: string }): Promise<void> {
  if (ctx.historic) {
    tally(ctx, entry.action.replace(/^integration\./, ''));
    return;
  }
  await logActivity(entry);
}

/** The claim row's id, or null when the event was already seen. */
async function claim(db: Db, orgId: string, source: EventSource, event: AccountEvent): Promise<string | null> {
  const data = {
    orgId,
    provider: source.slug,
    eventId: event.event_id,
    eventType: event.event_type,
    externalId: event.external_id,
    occurredAt: event.occurred_at,
    outcome: 'processing',
  };
  try {
    return (await db.integrationEvent.create({ data, select: { id: true } })).id;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
  }
  // Seen before. A finished event stays finished; a `processing` claim whose run
  // died is taken over by ONE conditional update (two takers cannot both win).
  const where = { orgId, provider: source.slug, eventId: data.eventId, outcome: 'processing', createdAt: { lt: new Date(Date.now() - CLAIM_STALE_MS) } };
  const taken = await db.integrationEvent.updateMany({ where, data: { createdAt: new Date() } });
  if (taken.count === 0) return null;
  const row = await db.integrationEvent.findFirst({
    where: { orgId, provider: source.slug, eventId: data.eventId },
    select: { id: true },
  });
  return row?.id ?? null;
}

async function apply(ctx: Ctx): Promise<IngestResult> {
  const { orgId, source, event, db } = ctx;
  const intent = ingestIntent(event.event_type);
  if (intent.kind === 'record') {
    await note(ctx, {
      action: 'integration.event',
      orgId,
      targetType: 'company_external_id',
      targetId: event.external_id,
      detail: `${source.slug}: ${event.event_type} (recorded; this event type has no funnel mapping)`,
    });
    // Recorded, but what it says about where the account came from still counts.
    if (event.referral_code || event.acquisition_source) {
      const known = await findAccounts(ctx);
      if (known.length === 1) await fillLeadSource(ctx, known[0].id);
    }
    return { outcome: 'recorded', detail: event.event_type };
  }

  const newest = await db.integrationEvent.findFirst({
    where: { orgId, provider: source.slug, externalId: event.external_id, outcome: 'applied' },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true },
  });
  if (isStaleEvent(event.occurred_at, newest?.occurredAt ?? null)) return { outcome: 'stale' };

  const accounts = await findAccounts(ctx);
  if (accounts.length > 1) return { outcome: 'conflict', detail: 'the external id is on several accounts — merge them first' };
  let companyId = accounts[0]?.id ?? null;
  const stages = await resolvePipelineStages(orgId);

  if (intent.kind !== 'open_trial') {
    // Only a trial event creates an account: a conversion, a loss or a
    // reactivation of an account the CRM never heard of has nothing to act on.
    if (!companyId) return { outcome: 'unknown_account' };
    const result = await moveAccount(ctx, companyId, intent, stages);
    await fillLeadSource(ctx, companyId);
    return result;
  }

  if (!companyId) {
    const created = await createAccount(ctx, stages);
    if (created.outcome !== 'exists') return created;
    companyId = created.companyId;
  }
  await fillGaps(ctx, companyId);
  const result = await moveAccount(ctx, companyId, intent, stages);
  await fillLeadSource(ctx, companyId);
  return result;
}

/** The accounts of the org carrying the event's external id (at most two: one is the answer, two a conflict). */
async function findAccounts(ctx: Ctx): Promise<{ id: string }[]> {
  const tenant = await orgWhere(ctx.orgId);
  return ctx.db.company.findMany({
    where: withinTenant({ externalId: ctx.event.external_id }, tenant),
    select: { id: true },
    take: 2,
  });
}

/**
 * A new account on the default owner's funnel, straight into TRIAL_ACTIVE — or,
 * when the event names no contact e-mail, the account alone (no funnel record).
 */
async function createAccount(
  ctx: Ctx,
  stages: Stages,
): Promise<IngestResult | { outcome: 'exists'; companyId: string }> {
  const { orgId, source, event, db } = ctx;
  const owner = await resolveDefaultLeadOwner(orgId);
  if (!owner) return { outcome: 'no_default_owner' };
  const leadSource = leadSourceName({ reference: event.referral_code, acquisitionSource: event.acquisition_source });
  const outcome = await createMarketingAccount({
    owner,
    fields: {
      name: accountNameFor(event.external_id, event.contact, source.label),
      contactName: contactFullName(event.contact) || undefined,
      contactEmail: event.contact?.email ?? undefined,
      externalId: event.external_id,
      stage: 'TRIAL_ACTIVE',
    },
    origin: 'ingest',
    actor: null,
    leadSourceName: leadSource.kind === 'unknown' ? null : leadSource.name,
    // Historic: the account, its lead and its record are dated at the event.
    ...(ctx.at ? { now: ctx.at, quiet: true } : {}),
    db,
  });
  switch (outcome.kind) {
    case 'created': {
      tally(ctx, 'account_created');
      const relation = await db.mentorshipRelation.findFirst({
        where: { companyId: outcome.companyId, status: 'ACTIVE' },
        select: { id: true },
      });
      // The import stamped the CRM's default window seconds ago; the dates the
      // event carries replace it.
      if (relation && (event.trial_started_at || event.trial_ends_at)) {
        await db.mentorshipRelation.update({
          where: { id: relation.id },
          data: {
            ...(event.trial_started_at ? { trialStartedAt: event.trial_started_at } : {}),
            ...(event.trial_ends_at ? { trialEndsAt: event.trial_ends_at } : {}),
          },
        });
      }
      await recordMachineContactPermission(db, {
        writer: 'ingest',
        orgId,
        companyId: outcome.companyId,
        address: event.contact?.email ?? null,
      });
      if (!relation) {
        return { outcome: 'applied', companyId: outcome.companyId, detail: NO_FUNNEL_RECORD_CREATED };
      }
      await settleHistoricTrial(ctx, relation.id, stages);
      return { outcome: 'applied', companyId: outcome.companyId, relationId: relation.id };
    }
    case 'exists':
      // Matched by name/VAT, not by the external id: the existing-account path
      // stamps the id into the gap and moves the record.
      return { outcome: 'exists', companyId: outcome.companyId };
    default:
      return { outcome: 'conflict', detail: 'reason' in outcome ? `${outcome.kind}: ${outcome.reason}` : outcome.kind };
  }
}

/** Gap-fill only: an operator's value is never overwritten by the feed. */
async function fillGaps(ctx: Ctx, companyId: string): Promise<void> {
  const { db, event } = ctx;
  const current = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { externalId: true, contactEmail: true, contactName: true },
  });
  const plan = planFieldUpdates(
    current,
    { externalId: event.external_id, contactEmail: event.contact?.email ?? null, contactName: contactFullName(event.contact) || null },
    { authoritative: false },
  );
  if (plan.changed.length > 0) await db.company.update({ where: { id: companyId }, data: plan.changes });
}

/**
 * Source fill (#2966): an acquisition source the source system learnt later —
 * an affiliate code or a sign-up channel on any event — is the lead's `Source`
 * when the lead has none yet. First touch, the import's own rule
 * (src/lib/marketingImportStore.ts placeOnFunnel): a lead that already has a
 * Source or a referring person keeps it, and the write is conditional on
 * exactly that, so a concurrent attribution is never overwritten.
 */
async function fillLeadSource(ctx: Ctx, companyId: string): Promise<void> {
  const { db, event, orgId } = ctx;
  const name = leadSourceName({ reference: event.referral_code, acquisitionSource: event.acquisition_source });
  if (name.kind === 'unknown') return;
  const records = await db.mentorshipRelation.findMany({
    where: { companyId, orgId },
    orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
    select: { status: true, menteeId: true },
    take: 5,
  });
  const record = records.find((r) => r.status === 'ACTIVE') ?? records[0];
  if (!record) return;
  const lead = await db.user.findUnique({ where: { id: record.menteeId }, select: { sourceId: true, referredById: true } });
  if (!lead || lead.sourceId || lead.referredById) return;
  const row = await findOrCreateSource(orgId, name.name, {}, db);
  const filled = await db.user.updateMany({
    where: { id: record.menteeId, sourceId: null, referredById: null },
    data: { sourceId: row.id },
  });
  if (filled.count > 0) tally(ctx, 'source_filled');
}

/** Did this record ever sign? It is at DEAL_WON, or its history shows the move. */
async function recordWasWon(ctx: Ctx, relation: RelationRow): Promise<boolean> {
  if (relation.pipelineStatus === WON_STAGE_KEY) return true;
  const row = await ctx.db.statusChange.findFirst({
    where: { relationId: relation.id, toStatus: WON_STAGE_KEY },
    select: { id: true },
  });
  return !!row;
}

async function moveAccount(
  ctx: Ctx,
  companyId: string,
  intent: Exclude<IngestIntent, { kind: 'record' }>,
  stages: Stages,
): Promise<IngestResult> {
  const { orgId, source, event, db } = ctx;
  const relations = await db.mentorshipRelation.findMany({
    where: { companyId, orgId },
    orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
    select: RELATION_SELECT,
    take: 5,
  });
  const relation = relations.find((r) => r.status === 'ACTIVE') ?? relations[0] ?? null;
  if (!relation) return { outcome: 'recorded', companyId, detail: 'the account has no funnel record; nothing moved' };

  const needsWon = intent.kind === 'lost' || intent.kind === 'reactivate';
  const plan = planAccountEvent({
    intent,
    record: {
      status: relation.status,
      pipelineStatus: relation.pipelineStatus,
      wasWon: needsWon ? await recordWasWon(ctx, relation) : false,
      trialEndsAt: relation.trialEndsAt,
    },
    stages,
    occurredAt: event.occurred_at,
    sourceSlug: source.slug,
  });

  switch (plan.kind) {
    case 'missing_stage':
      return { outcome: 'conflict', companyId, relationId: relation.id, detail: `the org has no ${plan.stage} stage` };
    case 'nothing':
      await note(ctx, {
        action: 'integration.event',
        orgId,
        targetType: 'MentorshipRelation',
        targetId: relation.id,
        detail: `${source.slug}: ${event.event_type} (recorded; ${plan.detail})`,
      });
      return { outcome: 'recorded', companyId, relationId: relation.id, detail: plan.detail };
    case 'refused_backward':
      await note(ctx, {
        action: 'integration.backward_refused',
        orgId,
        level: 'warning',
        targetType: 'MentorshipRelation',
        targetId: relation.id,
        detail: `${source.slug}: ${event.event_type}: ${relation.pipelineStatus} → ${plan.toStage} refused (a machine never moves a record backwards)`,
      });
      return { outcome: 'refused_backward', companyId, relationId: relation.id, detail: `${relation.pipelineStatus} → ${plan.toStage}` };
    case 'win_back':
      return newJourney(ctx, companyId, relation, plan, stages);
    case 'move': {
      if (plan.reasonCode) {
        // The drop-off reason is checked BEFORE the write, as on every stage
        // write path: a refused reason must never leave a moved record behind.
        const check = await validateDropoffReason({
          orgId,
          toStatus: plan.toStage,
          reasonCode: plan.reasonCode,
          reasonNote: plan.reasonNote ?? undefined,
        });
        if (!check.ok) return { outcome: 'conflict', companyId, relationId: relation.id, detail: check.error };
        tally(ctx, `lost_${plan.reasonCode.toLowerCase()}`);
      }
      await moveRelation(ctx, relation, plan);
      if (plan.toStage === TRIAL_ACTIVE_STAGE_KEY) await settleHistoricTrial(ctx, relation.id, stages);
      return { outcome: 'applied', companyId, relationId: relation.id };
    }
  }
}

/** The newest row of a record's stage history (null when it has none). */
function newestHistory(db: Db, relationId: string) {
  return db.statusChange.findFirst({
    where: { relationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, fromStatus: true, toStatus: true, changedById: true, createdAt: true },
  });
}

/**
 * One in-place move. A LIVE move writes the stage and its trial window, then
 * hands the rest to the shared stage write path (`recordStageMove`: history
 * row, activity line, SLA, bell, webhook). A HISTORIC move is one silent
 * transaction: the stage, its window and a backdated history row. It first
 * takes back the replay's own expiry when the move came before it
 * (`shouldUndoHistoricExpiry`), and is dated at the event but never at or
 * before the record's newest history row (`historicMoveAt`).
 */
async function moveRelation(ctx: Ctx, relation: RelationRow, plan: Extract<EventPlan, { kind: 'move' }>): Promise<void> {
  const { orgId, event, source } = ctx;
  const toStage = plan.toStage;
  const window =
    toStage === TRIAL_ACTIVE_STAGE_KEY
      ? ingestTrialWindow(
          { trialStartedAt: relation.trialStartedAt, trialEndsAt: relation.trialEndsAt },
          { trialStartedAt: event.trial_started_at ?? null, trialEndsAt: event.trial_ends_at ?? null },
          trialWindowFor({
            toStage,
            enteredAt: event.occurred_at,
            existing: {
              trialStartedAt: relation.trialStartedAt ?? event.trial_started_at,
              trialEndsAt: relation.trialEndsAt ?? event.trial_ends_at,
            },
            lengthDays: await trialLengthDaysFor(orgId),
          }),
        )
      : {};

  if (!ctx.at) {
    await ctx.db.mentorshipRelation.update({ where: { id: relation.id }, data: { pipelineStatus: toStage, ...window } });
    await recordStageMove({
      relation: { id: relation.id, menteeId: relation.menteeId, orgId, pipelineStatus: relation.pipelineStatus },
      toStatus: toStage,
      actor: null,
      reasonCode: plan.reasonCode ?? null,
      reasonNote: plan.reasonNote ?? null,
      cause: `${source.slug}: ${event.event_type}`,
    });
    return;
  }

  const at = ctx.at;
  const undone = await inTransaction(ctx.db, async (tx) => {
    let fromStatus = relation.pipelineStatus;
    let undoneExpiry = false;
    let newest = await newestHistory(tx, relation.id);
    if (newest && shouldUndoHistoricExpiry({ pipelineStatus: fromStatus, toStage, at, newest })) {
      // Conditional, like the expiry itself: only the state just read.
      const back = await tx.mentorshipRelation.updateMany({
        where: { id: relation.id, pipelineStatus: TRIAL_EXPIRED_STAGE_KEY },
        data: { pipelineStatus: TRIAL_ACTIVE_STAGE_KEY },
      });
      if (back.count === 1) {
        await tx.statusChange.delete({ where: { id: newest.id } });
        fromStatus = TRIAL_ACTIVE_STAGE_KEY;
        undoneExpiry = true;
        newest = await newestHistory(tx, relation.id);
      }
    }
    // Historic: the move happened at the event, not at the replay — but not
    // underneath history the record already has.
    const createdAt = historicMoveAt(at, { startDate: relation.startDate, newestHistoryAt: newest?.createdAt ?? null });
    const history = statusChangeData({
      relationId: relation.id,
      fromStatus,
      toStatus: toStage,
      changedById: null,
      createdAt,
      ...(plan.reasonCode ? { reasonCode: plan.reasonCode } : {}),
      ...(plan.reasonNote ? { reasonNote: plan.reasonNote } : {}),
    });
    await tx.mentorshipRelation.update({ where: { id: relation.id }, data: { pipelineStatus: toStage, ...window } });
    if (history) await tx.statusChange.create({ data: history });
    return undoneExpiry;
  });
  if (undone) tally(ctx, 'trial_expiry_undone');
}

/**
 * A new journey for an account whose record has ended (lost, closed) or whose
 * trial ran out: chained by `previousRelationId`, for the same lead and owner,
 * through the one win-back writer (`winBack()`, src/lib/winBack.ts). The old
 * record is not reopened; an ACTIVE one is closed first (ENDED_CHURNED), so the
 * lead never has two active records (#419) — and if the lead somehow already
 * has another active record, nothing is written and the answer is a conflict.
 * Historic: the old record ends, and the new one starts, at the event (never
 * underneath what the old record already went through), with no stage deadline.
 */
async function newJourney(
  ctx: Ctx,
  companyId: string,
  previous: RelationRow,
  plan: Extract<EventPlan, { kind: 'win_back' }>,
  stages: Stages,
): Promise<IngestResult> {
  const { orgId, source, event } = ctx;
  const at = ctx.at
    ? historicMoveAt(ctx.at, {
        startDate: previous.startDate,
        newestHistoryAt: (await newestHistory(ctx.db, previous.id))?.createdAt ?? null,
      })
    : undefined;
  const trialWindow =
    plan.toStage === TRIAL_ACTIVE_STAGE_KEY
      ? ingestTrialWindow(
          { trialStartedAt: null, trialEndsAt: null },
          { trialStartedAt: event.trial_started_at ?? null, trialEndsAt: event.trial_ends_at ?? null },
          trialWindowFor({
            toStage: plan.toStage,
            enteredAt: event.occurred_at,
            existing: null,
            lengthDays: await trialLengthDaysFor(orgId),
          }),
        )
      : {};
  let newRelationId: string;
  try {
    ({ newRelationId } = await winBack({
      relationId: previous.id,
      toStage: plan.toStage,
      expect: { pipelineStatus: previous.pipelineStatus, ...(plan.predecessorClosed ? { closed: true } : {}) },
      ...(at ? { at } : {}),
      quiet: ctx.historic,
      trialWindow,
      db: ctx.db,
    }));
  } catch (e) {
    if (e instanceof WinBackConflictError) {
      return { outcome: 'conflict', companyId, relationId: previous.id, detail: 'the record changed meanwhile' };
    }
    if (e instanceof AlreadyMentoredError) {
      return { outcome: 'conflict', companyId, relationId: previous.id, detail: 'the lead already has another active record' };
    }
    throw e;
  }
  await note(ctx, {
    action: 'integration.new_journey',
    orgId,
    targetType: 'MentorshipRelation',
    targetId: newRelationId,
    detail: `${source.slug}: ${event.event_type}: new journey at ${plan.toStage} after ${previous.pipelineStatus} (${previous.id})`,
  });
  await settleHistoricTrial(ctx, newRelationId, stages);
  return { outcome: 'applied', companyId, relationId: newRelationId };
}

/**
 * Historic only: a record a replayed event just put into a trial lands where
 * the trial actually is today (`historicTrialLanding`). A trial that ran out
 * moves to TRIAL_EXPIRED here and now, with a system history row dated at the
 * trial's end — the daily sweep would otherwise move it tomorrow and date the
 * move tomorrow. A decision window that has already closed gets its one claim
 * row (`DECISION_WINDOW_CLAIM`, the same unique the sweep claims with), so the
 * sweep never rings about it. Nothing is mailed and nothing is rung from here.
 */
async function settleHistoricTrial(ctx: Ctx, relationId: string, stages: Stages): Promise<void> {
  if (!ctx.historic || !ctx.at) return;
  const { db } = ctx;
  const hasExpired = stages.some((s) => s.key === TRIAL_EXPIRED_STAGE_KEY);
  const relation = await db.mentorshipRelation.findUnique({
    where: { id: relationId },
    select: { pipelineStatus: true, trialEndsAt: true, startDate: true },
  });
  if (!relation) return;
  // The record entered the trial at its newest history row (the move just
  // written, possibly held after a person's newer move) or at its start.
  const newest = await newestHistory(db, relationId);
  const enteredAt = new Date(
    Math.max(ctx.at.getTime(), relation.startDate.getTime(), newest?.createdAt.getTime() ?? 0),
  );
  const landing = historicTrialLanding({
    pipelineStatus: relation.pipelineStatus,
    trialEndsAt: relation.trialEndsAt,
    enteredAt,
    now: ctx.now,
    decisionWindowDays: await decisionWindowDaysFor(ctx.orgId),
  });

  let status = relation.pipelineStatus;
  if (landing.expire && landing.expiredAt && hasExpired) {
    const expiredAt = landing.expiredAt;
    const moved = await inTransaction(db, async (tx) => {
      // Conditional, like the sweep's own expiry: whoever moved it first wins.
      const claimed = await tx.mentorshipRelation.updateMany({
        where: { id: relationId, pipelineStatus: TRIAL_ACTIVE_STAGE_KEY },
        data: { pipelineStatus: TRIAL_EXPIRED_STAGE_KEY },
      });
      if (claimed.count === 0) return false;
      const row = statusChangeData({
        relationId,
        fromStatus: TRIAL_ACTIVE_STAGE_KEY,
        toStatus: TRIAL_EXPIRED_STAGE_KEY,
        changedById: null,
        createdAt: expiredAt,
      });
      if (row) await tx.statusChange.create({ data: row });
      return true;
    });
    if (moved) {
      status = TRIAL_EXPIRED_STAGE_KEY;
      tally(ctx, 'trial_expired');
    }
  }

  if (landing.preclaimDecisionWindow && status === TRIAL_EXPIRED_STAGE_KEY) {
    // `orgId` explicitly: TrialReminder is tenant data and a feed has no session.
    // `sentAt` is deliberately NOT backdated: the retention prune deletes claim
    // rows by `sentAt` after a year, and a claim dated years back would be
    // pruned on the next run and un-suppress the very bell it exists to stop.
    await db.trialReminder.createMany({
      data: [{ orgId: ctx.orgId, relationId, threshold: DECISION_WINDOW_CLAIM }],
      skipDuplicates: true,
    });
  }
}

// ── The batch (#2966) ────────────────────────────────────────────────────────
//
// docs/integrations/account-events.md § Batch. One request, at most
// ACCOUNT_EVENT_BATCH_MAX events of one source, processed one after another in
// (external_id, occurred_at) order — the order a replay must be applied in,
// whatever order the sender listed them — and ALWAYS in historic mode: a batch
// is a replay of the past by definition. Each event is exactly one
// `ingestAccountEvent` call (its own claim, its own transactions), so a batch
// that dies halfway is retried whole and the events it already handled answer
// `duplicate`. The answers come back in the REQUEST's order.
//
// A DRY RUN is the same loop, through the same call, inside ONE transaction
// that is rolled back at the end (src/lib/dbHandle.ts): every read sees what
// the earlier events of the run wrote, so a `converted` after an
// `account_created` of the same batch is judged exactly as the real run would
// judge it — and nothing is committed. Its limits: the ids the run assigned are
// gone with the rollback, so a dry answer carries no `companyId` /
// `relationId`; the replay's activity line is not written; and while it runs
// it holds the row locks a real run would take, so a live event for the same
// account waits for it (seconds, bounded by DRY_RUN_TIMEOUT_MS).

export { ACCOUNT_EVENT_BATCH_MAX } from '@/lib/accountEventRule';

/** How long one dry run may hold its transaction. */
export const DRY_RUN_TIMEOUT_MS = 120_000;

export interface BatchItemResult extends IngestResult {
  /** The event's position in the request (0-based). */
  index: number;
  event_id: string;
}

class DryRunRollback extends Error {
  constructor(readonly results: BatchItemResult[]) {
    super('dry run: rolled back');
  }
}

export async function ingestAccountEventBatch(
  orgId: string,
  source: EventSource,
  events: readonly AccountEvent[],
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<BatchItemResult[]> {
  const now = options.now ?? new Date();
  const run = async (db: Db, log: ReplayLog): Promise<BatchItemResult[]> => {
    const results: BatchItemResult[] = new Array(events.length);
    for (const index of batchOrder(events)) {
      const event = { ...events[index], replay: true };
      const result = await ingestAccountEvent(orgId, source, event, { now, replayLog: log, db });
      results[index] = { index, event_id: event.event_id, ...result };
    }
    return results;
  };

  if (!options.dryRun) {
    const log = newReplayLog();
    try {
      return await run(prisma, log);
    } finally {
      await flushReplayLog(orgId, source, log);
    }
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        throw new DryRunRollback(await run(tx, newReplayLog()));
      },
      { timeout: DRY_RUN_TIMEOUT_MS, maxWait: 10_000 },
    );
  } catch (e) {
    if (e instanceof DryRunRollback) {
      // The ids belong to rows the rollback removed: never hand them out.
      return e.results.map((r) => {
        const dry: BatchItemResult = { ...r };
        delete dry.companyId;
        delete dry.relationId;
        return dry;
      });
    }
    throw e;
  }
  throw new Error('dry run: the transaction was not rolled back');
}
