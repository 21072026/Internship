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
// stage, and a refused move is logged, not swallowed. A lost (off-path) record
// is never reopened: a new trial opens a NEW journey chained by
// `previousRelationId`, and the old record stays as it ended.
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
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { orgWhere, withinTenant } from '@/lib/tenantFilter';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { isBackwardMove, statusChangeData } from '@/lib/stageChange';
import { trialWindowFor } from '@/lib/trialReminderRule';
import { trialLengthDaysFor } from '@/lib/trialWindow';
import { planFieldUpdates } from '@/lib/externalSyncPolicy';
import { resolveDefaultLeadOwner } from '@/lib/leadOwner';
import { createMarketingAccount } from '@/lib/marketingImportStore';
import { recordMachineContactPermission } from '@/lib/contactPermission';
import { leadSourceName } from '@/lib/leadSourceName';
import { logActivity } from '@/lib/activity';
import {
  accountNameFor,
  contactFullName,
  ingestIntent,
  ingestTrialWindow,
  isStaleEvent,
} from '@/lib/accountEventRule';
import type { AccountEvent } from '@/lib/accountEventSchema';

/** A `processing` claim older than this belongs to a run that died. */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

/** The `detail` of a new account created without a funnel record. */
export const NO_FUNNEL_RECORD_CREATED =
  "account created without a funnel record (a record needs the contact's e-mail); an operator places it on the funnel";

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
}

type Stages = Awaited<ReturnType<typeof resolvePipelineStages>>;

/** What the writer needs to know about the source: its key and its name. */
export interface EventSource {
  slug: string;
  label: string;
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
} as const;
type RelationRow = Prisma.MentorshipRelationGetPayload<{ select: typeof RELATION_SELECT }>;

export async function ingestAccountEvent(orgId: string, source: EventSource, event: AccountEvent): Promise<IngestResult> {
  return runWithOrg(orgId, async () => {
    const claimId = await claim(orgId, source, event);
    if (!claimId) return { outcome: 'duplicate' };
    let result: IngestResult;
    try {
      result = await apply(orgId, source, event);
    } catch (e) {
      await prisma.integrationEvent.delete({ where: { id: claimId } }).catch(() => {});
      throw e;
    }
    if (result.outcome === 'no_default_owner') {
      // Retryable: nothing was written, and the org's setting is what is missing.
      await prisma.integrationEvent.delete({ where: { id: claimId } });
      return result;
    }
    await prisma.integrationEvent.update({
      where: { id: claimId },
      data: { outcome: result.outcome, companyId: result.companyId ?? null, detail: result.detail?.slice(0, 500) ?? null },
    });
    return result;
  });
}

/** The claim row's id, or null when the event was already seen. */
async function claim(orgId: string, source: EventSource, event: AccountEvent): Promise<string | null> {
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
    return (await prisma.integrationEvent.create({ data, select: { id: true } })).id;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
  }
  // Seen before. A finished event stays finished; a `processing` claim whose run
  // died is taken over by ONE conditional update (two takers cannot both win).
  const where = { orgId, provider: source.slug, eventId: data.eventId, outcome: 'processing', createdAt: { lt: new Date(Date.now() - CLAIM_STALE_MS) } };
  const taken = await prisma.integrationEvent.updateMany({ where, data: { createdAt: new Date() } });
  if (taken.count === 0) return null;
  const row = await prisma.integrationEvent.findFirst({
    where: { orgId, provider: source.slug, eventId: data.eventId },
    select: { id: true },
  });
  return row?.id ?? null;
}

async function apply(orgId: string, source: EventSource, event: AccountEvent): Promise<IngestResult> {
  const intent = ingestIntent(event.event_type);
  if (intent.kind === 'record') {
    await logActivity({
      action: 'integration.event',
      orgId,
      targetType: 'company_external_id',
      targetId: event.external_id,
      detail: `${source.slug}: ${event.event_type} (recorded; this event type has no funnel mapping)`,
    });
    return { outcome: 'recorded', detail: event.event_type };
  }

  const newest = await prisma.integrationEvent.findFirst({
    where: { orgId, provider: source.slug, externalId: event.external_id, outcome: 'applied' },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true },
  });
  if (isStaleEvent(event.occurred_at, newest?.occurredAt ?? null)) return { outcome: 'stale' };

  const tenant = await orgWhere(orgId);
  const accounts = await prisma.company.findMany({
    where: withinTenant({ externalId: event.external_id }, tenant),
    select: { id: true },
    take: 2,
  });
  if (accounts.length > 1) return { outcome: 'conflict', detail: 'the external id is on several accounts — merge them first' };
  let companyId = accounts[0]?.id ?? null;
  const stages = await resolvePipelineStages(orgId);

  if (intent.kind === 'won') {
    if (!companyId) return { outcome: 'unknown_account' };
    return moveAccount(orgId, companyId, intent.toStage, stages, source, event);
  }

  if (!companyId) {
    const created = await createAccount(orgId, source, event);
    if (created.outcome !== 'exists') return created;
    companyId = created.companyId;
  }
  await fillGaps(companyId, event);
  return moveAccount(orgId, companyId, intent.toStage, stages, source, event);
}

/**
 * A new account on the default owner's funnel, straight into TRIAL_ACTIVE — or,
 * when the event names no contact e-mail, the account alone (no funnel record).
 */
async function createAccount(
  orgId: string,
  source: EventSource,
  event: AccountEvent,
): Promise<IngestResult | { outcome: 'exists'; companyId: string }> {
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
  });
  switch (outcome.kind) {
    case 'created': {
      const relation = await prisma.mentorshipRelation.findFirst({
        where: { companyId: outcome.companyId, status: 'ACTIVE' },
        select: { id: true },
      });
      // The import stamped the CRM's default window seconds ago; the dates the
      // event carries replace it.
      if (relation && (event.trial_started_at || event.trial_ends_at)) {
        await prisma.mentorshipRelation.update({
          where: { id: relation.id },
          data: {
            ...(event.trial_started_at ? { trialStartedAt: event.trial_started_at } : {}),
            ...(event.trial_ends_at ? { trialEndsAt: event.trial_ends_at } : {}),
          },
        });
      }
      await recordMachineContactPermission(prisma, {
        writer: 'ingest',
        orgId,
        companyId: outcome.companyId,
        address: event.contact?.email ?? null,
      });
      if (!relation) {
        return { outcome: 'applied', companyId: outcome.companyId, detail: NO_FUNNEL_RECORD_CREATED };
      }
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
async function fillGaps(companyId: string, event: AccountEvent): Promise<void> {
  const current = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { externalId: true, contactEmail: true, contactName: true },
  });
  const plan = planFieldUpdates(
    current,
    { externalId: event.external_id, contactEmail: event.contact?.email ?? null, contactName: contactFullName(event.contact) || null },
    { authoritative: false },
  );
  if (plan.changed.length > 0) await prisma.company.update({ where: { id: companyId }, data: plan.changes });
}

async function moveAccount(
  orgId: string,
  companyId: string,
  toStage: string,
  stages: Stages,
  source: EventSource,
  event: AccountEvent,
): Promise<IngestResult> {
  const relations = await prisma.mentorshipRelation.findMany({
    where: { companyId, orgId },
    orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
    select: RELATION_SELECT,
    take: 5,
  });
  const relation = relations.find((r) => r.status === 'ACTIVE') ?? relations[0] ?? null;
  if (!relation) return { outcome: 'recorded', companyId, detail: 'the account has no funnel record; nothing moved' };

  const current = stages.find((s) => s.key === relation.pipelineStatus);
  const closed = relation.status !== 'ACTIVE' || !!current?.isOffPath;
  if (closed && toStage === 'TRIAL_ACTIVE') return newJourney(orgId, companyId, relation, toStage, stages, source, event);
  if (closed || isBackwardMove(stages, relation.pipelineStatus, toStage)) {
    await logActivity({
      action: 'integration.backward_refused',
      orgId,
      level: 'warning',
      targetType: 'MentorshipRelation',
      targetId: relation.id,
      detail: `${source.slug}: ${event.event_type}: ${relation.pipelineStatus} → ${toStage} refused (a machine never moves a record backwards)`,
    });
    return { outcome: 'refused_backward', companyId, relationId: relation.id, detail: `${relation.pipelineStatus} → ${toStage}` };
  }
  await moveRelation(orgId, relation, toStage, event);
  return { outcome: 'applied', companyId, relationId: relation.id };
}

/** One transaction: the stage, its trial window, and the history row. */
async function moveRelation(orgId: string, relation: RelationRow, toStage: string, event: AccountEvent): Promise<void> {
  const window =
    toStage === 'TRIAL_ACTIVE'
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
  const history = statusChangeData({
    relationId: relation.id,
    fromStatus: relation.pipelineStatus,
    toStatus: toStage,
    changedById: null,
  });
  await prisma.$transaction([
    prisma.mentorshipRelation.update({ where: { id: relation.id }, data: { pipelineStatus: toStage, ...window } }),
    ...(history ? [prisma.statusChange.create({ data: history })] : []),
  ]);
}

/**
 * A new trial for an account whose record is closed (lost, or completed): a NEW
 * journey, chained by `previousRelationId`, for the same lead and owner. The
 * old record is not reopened; an ACTIVE-but-lost one is completed first, so
 * the lead never has two active records (#419).
 */
async function newJourney(
  orgId: string,
  companyId: string,
  previous: RelationRow,
  toStage: string,
  stages: Stages,
  source: EventSource,
  event: AccountEvent,
): Promise<IngestResult> {
  if (!stages.some((s) => s.key === toStage)) return { outcome: 'conflict', detail: `the org has no ${toStage} stage` };
  const window = ingestTrialWindow(
    { trialStartedAt: null, trialEndsAt: null },
    { trialStartedAt: event.trial_started_at ?? null, trialEndsAt: event.trial_ends_at ?? null },
    trialWindowFor({ toStage, enteredAt: event.occurred_at, existing: null, lengthDays: await trialLengthDaysFor(orgId) }),
  );
  const created = await prisma.$transaction(async (tx) => {
    if (previous.status === 'ACTIVE') {
      await tx.mentorshipRelation.update({
        where: { id: previous.id, status: 'ACTIVE' },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    }
    return tx.mentorshipRelation.create({
      data: {
        orgId,
        companyId,
        mentorId: previous.mentorId,
        menteeId: previous.menteeId,
        pipelineStatus: toStage,
        previousRelationId: previous.id,
        ...window,
      },
      select: { id: true },
    });
  });
  await logActivity({
    action: 'integration.new_journey',
    orgId,
    targetType: 'MentorshipRelation',
    targetId: created.id,
    detail: `${source.slug}: ${event.event_type}: new journey after ${previous.pipelineStatus} (${previous.id})`,
  });
  return { outcome: 'applied', companyId, relationId: created.id };
}
