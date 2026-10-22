// The Klaviyo connector beyond profiles — the Prisma half and the ONLY writer of
// ExternalSyncState, ExternalAudience(+Member), ExternalMetric, ExternalEvent,
// ExternalCampaign(+Message, +Stat) and ExternalFlow
// (docs/integrations/klaviyo.md § Beyond profiles). The rules — paths, mapping,
// schedule — are the pure ones in src/lib/klaviyoResourceRule.ts.
//
// WHAT A RUN DOES
//   Under the connection's lease (the same one the profile run takes, so the
//   two never overlap), every resource that is due — in an order where each
//   one finds what it depends on: metrics before events, lists and segments
//   before their members, campaigns before their statistics. A resource has its
//   own cursor, status and backoff (ExternalSyncState): a key that may not read
//   flows records `forbidden` on `flows` alone, and everything else syncs.
//
// IDEMPOTENT
//   Every row is upserted by (connection, provider id): a re-read page, a
//   retried run or two replicas cannot make a duplicate. Events are immutable
//   and inserted with skipDuplicates. A full pass stamps `seenAt` and then
//   removes what it did not see — the only way a deletion on the provider's
//   side reaches us. Events are never pruned by a pass; they leave by the
//   retention sweep (EVENT_RETENTION_DAYS), an erasure, or a disconnect.
//
// ERASED PEOPLE
//   A profile id whose link is an erasure tombstone is never written as an
//   event or a member (the same rule the profile sync applies).
//
// TENANCY
//   Sessionless: the connection row says which tenant; the run binds it with
//   runWithOrg and passes `orgId` on every write. Every state write is guarded
//   on the key the run opened (`connection.sealedKey`), so a key replaced
//   mid-run (which wipes this data) is never written over.
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { runWithOrg } from '@/lib/orgContext';
import { acquireLease, releaseLease, replicaId } from '@/lib/jobs/lease';
import { verticalFor } from '@/lib/verticalContext';
import { openConnectionKey } from '@/lib/klaviyoKey';
import { fetchResourcePage, klaviyoQuery, type KlaviyoClientOptions, type KlaviyoRequestOptions } from '@/lib/klaviyoClient';
import { KLAVIYO_PROVIDER, nextAttemptDelayMs, type KlaviyoErrorCode } from '@/lib/klaviyoRule';
import {
  CAMPAIGN_STATS_MAX_PAGES,
  CAMPAIGN_STATS_TIMEFRAME,
  DEFAULT_CONVERSION_METRIC,
  RESOURCE_PACE_MS,
  RESOURCE_PAGES_PER_MANUAL_RUN,
  RESOURCE_PAGES_PER_RESOURCE,
  RESOURCE_PAGES_PER_RUN,
  RESOURCE_RUN_TIME_BUDGET_MS,
  afterResourcePage,
  beginPass,
  campaignStatsPath,
  campaignStatsQuery,
  catalogPath,
  eventMetricAllowlist,
  eventRetentionCutoff,
  eventsPath,
  eventsWindowStart,
  isEventMetricAllowed,
  isResourceDue,
  mapAudience,
  mapCampaign,
  mapCampaignStat,
  mapEvent,
  mapFlow,
  mapMember,
  mapMetric,
  membersPath,
  reportNextCursor,
  stateKey,
  type KlaviyoCatalogResource,
  type KlaviyoResourceKind,
  type PassState,
} from '@/lib/klaviyoResourceRule';

/** The connection's lease — shared with the profile run (klaviyoSync.ts). */
export function klaviyoLeaseName(connectionId: string): string {
  return `klaviyo-sync:${connectionId}`;
}
export const KLAVIYO_LEASE_TTL_MS = 10 * 60 * 1000;

const STATE_SELECT = {
  id: true,
  resource: true,
  since: true,
  queryStartedAt: true,
  queryMode: true,
  pageCursor: true,
  lastFullAt: true,
  lastRunAt: true,
  nextAttemptAt: true,
  failures: true,
  totalCount: true,
} satisfies Prisma.ExternalSyncStateSelect;
type StateRow = Prisma.ExternalSyncStateGetPayload<{ select: typeof STATE_SELECT }>;

function passOf(row: StateRow | null): PassState {
  return {
    since: row?.since ?? null,
    queryStartedAt: row?.queryStartedAt ?? null,
    queryMode: (row?.queryMode as PassState['queryMode']) ?? null,
    pageCursor: row?.pageCursor ?? null,
    lastFullAt: row?.lastFullAt ?? null,
    lastRunAt: row?.lastRunAt ?? null,
    nextAttemptAt: row?.nextAttemptAt ?? null,
  };
}

interface RunCtx {
  orgId: string;
  connectionId: string;
  sealedKey: string;
  key: string;
  client?: KlaviyoClientOptions;
  clock: () => Date;
  startedAt: number;
  pagesLeft: number;
  states: Map<string, StateRow>;
  force: boolean;
}

/** Why a resource stopped: a provider failure (code) or a key replaced mid-run. */
type Stop = { ok: true; count: number; errors: number } | { ok: false; code: KlaviyoErrorCode; retryAfterMs?: number | null } | { ok: false; code: 'superseded' };

class Superseded extends Error {}

function budgetLeft(ctx: RunCtx): boolean {
  return ctx.pagesLeft > 0 && ctx.clock().getTime() - ctx.startedAt < RESOURCE_RUN_TIME_BUDGET_MS;
}

function req(ctx: RunCtx, family: string): KlaviyoRequestOptions {
  return { ...(ctx.client ?? {}), family: `klaviyo:${family}`, minIntervalMs: RESOURCE_PACE_MS[family] };
}

/** The state row of a resource, created on first use. */
async function stateFor(ctx: RunCtx, resource: string): Promise<StateRow> {
  const known = ctx.states.get(resource);
  if (known) return known;
  const row = await prisma.externalSyncState.upsert({
    where: { connectionId_resource: { connectionId: ctx.connectionId, resource } },
    create: { orgId: ctx.orgId, connectionId: ctx.connectionId, resource },
    update: {},
    select: STATE_SELECT,
  });
  ctx.states.set(resource, row);
  return row;
}

/** One guarded state write: zero rows means the key changed (or the connection went) — stop. */
async function writeState(ctx: RunCtx, row: StateRow, data: Prisma.ExternalSyncStateUpdateManyMutationInput): Promise<void> {
  const { count } = await prisma.externalSyncState.updateMany({
    where: { id: row.id, orgId: ctx.orgId, connection: { sealedKey: ctx.sealedKey } },
    data,
  });
  if (count === 0) throw new Superseded();
}

async function savePass(ctx: RunCtx, row: StateRow, pass: PassState): Promise<void> {
  await writeState(ctx, row, {
    since: pass.since,
    queryStartedAt: pass.queryStartedAt,
    queryMode: pass.queryMode,
    pageCursor: pass.pageCursor,
    lastFullAt: pass.lastFullAt,
  });
  Object.assign(row, {
    since: pass.since,
    queryStartedAt: pass.queryStartedAt,
    queryMode: pass.queryMode,
    pageCursor: pass.pageCursor,
    lastFullAt: pass.lastFullAt,
  });
}

async function finish(ctx: RunCtx, row: StateRow, stop: Stop): Promise<void> {
  if (!stop.ok && stop.code === 'superseded') return;
  const at = ctx.clock();
  if (stop.ok) {
    await writeState(ctx, row, {
      lastRunAt: at,
      lastOkAt: at,
      status: stop.errors > 0 ? 'partial' : 'ok',
      errorCode: null,
      failures: 0,
      nextAttemptAt: null,
      lastCount: stop.count,
      lastErrors: stop.errors,
      totalCount: { increment: stop.count },
    });
    return;
  }
  const failures = row.failures + 1;
  await writeState(ctx, row, {
    lastRunAt: at,
    status: 'error',
    errorCode: stop.code,
    failures,
    nextAttemptAt: new Date(at.getTime() + nextAttemptDelayMs(failures, stop.retryAfterMs ?? null)),
  });
  logger.warning('klaviyo resource sync failed', { connectionId: ctx.connectionId, orgId: ctx.orgId, resource: row.resource, code: stop.code });
}

/** The profile ids among `ids` whose person was erased (tombstoned links). */
async function erasedProfileIds(orgId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await prisma.externalProfileLink.findMany({
    where: { orgId, provider: KLAVIYO_PROVIDER, externalId: { in: [...new Set(ids)] }, erasedAt: { not: null } },
    select: { externalId: true },
  });
  return new Set(rows.map((r) => r.externalId));
}

/**
 * Walk one resource's pages until its pass ends or the run's budget does.
 * `apply` writes one page and returns how many rows it wrote and could not map.
 */
async function walk(
  ctx: RunCtx,
  kind: KlaviyoResourceKind,
  row: StateRow,
  path: (pass: PassState) => string,
  apply: (page: { data: unknown[]; included: unknown[] }, seenAt: Date) => Promise<{ count: number; errors: number }>,
  onPassDone?: (pruneBefore: Date | null) => Promise<void>,
): Promise<Stop> {
  let pass = beginPass(kind, passOf(row), ctx.clock());
  if (pass.queryStartedAt !== row.queryStartedAt) await savePass(ctx, row, pass);
  let count = 0;
  let errors = 0;
  let restarted = false;
  let pages = 0;
  while (budgetLeft(ctx) && pages < RESOURCE_PAGES_PER_RESOURCE) {
    const page = await fetchResourcePage(path(pass), ctx.key, req(ctx, kind));
    if (!page.ok) {
      // A stale page cursor: restart the open pass once. Upserts make the
      // re-read harmless.
      if (page.code === 'bad_request' && pass.pageCursor && !restarted) {
        restarted = true;
        pass = { ...pass, pageCursor: null };
        continue;
      }
      return { ok: false, code: page.code, retryAfterMs: page.retryAfterMs ?? null };
    }
    ctx.pagesLeft -= 1;
    pages += 1;
    const seenAt = pass.queryStartedAt ?? ctx.clock();
    const r = await apply(page.data, seenAt);
    count += r.count;
    errors += r.errors;
    const step = afterResourcePage(pass, page.data.nextCursor);
    if (step.passDone && onPassDone) await onPassDone(step.pruneBefore);
    pass = step.state;
    await savePass(ctx, row, pass);
    if (step.passDone) break;
  }
  return { ok: true, count, errors };
}

// ── Catalog resources ────────────────────────────────────────────────────────

async function applyAudiences(ctx: RunCtx, kind: 'list' | 'segment', data: unknown[], seenAt: Date) {
  let errors = 0;
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const item of data) {
    const a = mapAudience(item, kind);
    if (!a) {
      errors += 1;
      continue;
    }
    const fields = { name: a.name, isActive: a.isActive, providerCreatedAt: a.providerCreatedAt, providerUpdatedAt: a.providerUpdatedAt, seenAt };
    ops.push(
      prisma.externalAudience.upsert({
        where: { connectionId_kind_externalId: { connectionId: ctx.connectionId, kind, externalId: a.externalId } },
        create: { orgId: ctx.orgId, connectionId: ctx.connectionId, kind, externalId: a.externalId, ...fields },
        update: fields,
      }),
    );
  }
  if (ops.length) await prisma.$transaction(ops);
  return { count: ops.length, errors };
}

async function applyMetrics(ctx: RunCtx, data: unknown[], seenAt: Date) {
  let errors = 0;
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const item of data) {
    const m = mapMetric(item);
    if (!m) {
      errors += 1;
      continue;
    }
    const { externalId, ...rest } = m;
    ops.push(
      prisma.externalMetric.upsert({
        where: { connectionId_externalId: { connectionId: ctx.connectionId, externalId } },
        create: { orgId: ctx.orgId, connectionId: ctx.connectionId, externalId, ...rest, seenAt },
        update: { ...rest, seenAt },
      }),
    );
  }
  if (ops.length) await prisma.$transaction(ops);
  return { count: ops.length, errors };
}

async function applyFlows(ctx: RunCtx, data: unknown[], seenAt: Date) {
  let errors = 0;
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const item of data) {
    const f = mapFlow(item);
    if (!f) {
      errors += 1;
      continue;
    }
    const { externalId, ...rest } = f;
    ops.push(
      prisma.externalFlow.upsert({
        where: { connectionId_externalId: { connectionId: ctx.connectionId, externalId } },
        create: { orgId: ctx.orgId, connectionId: ctx.connectionId, externalId, ...rest, seenAt },
        update: { ...rest, seenAt },
      }),
    );
  }
  if (ops.length) await prisma.$transaction(ops);
  return { count: ops.length, errors };
}

async function applyCampaigns(ctx: RunCtx, data: unknown[], included: unknown[], seenAt: Date) {
  let count = 0;
  let errors = 0;
  for (const item of data) {
    const c = mapCampaign(item, included);
    if (!c) {
      errors += 1;
      continue;
    }
    const { externalId, messages, ...rest } = c;
    // One campaign and its messages in one transaction: the message set is the
    // provider's and is replaced, so a removed message does not linger.
    await prisma.$transaction(async (tx) => {
      const campaign = await tx.externalCampaign.upsert({
        where: { connectionId_externalId: { connectionId: ctx.connectionId, externalId } },
        create: { orgId: ctx.orgId, connectionId: ctx.connectionId, externalId, ...rest, seenAt },
        update: { ...rest, seenAt },
        select: { id: true },
      });
      await tx.externalCampaignMessage.deleteMany({
        where: { orgId: ctx.orgId, campaignId: campaign.id, externalId: { notIn: messages.map((m) => m.externalId) } },
      });
      for (const m of messages) {
        const { externalId: messageId, ...fields } = m;
        await tx.externalCampaignMessage.upsert({
          where: { campaignId_externalId: { campaignId: campaign.id, externalId: messageId } },
          create: { orgId: ctx.orgId, campaignId: campaign.id, externalId: messageId, ...fields },
          update: fields,
        });
      }
    });
    count += 1;
  }
  return { count, errors };
}

/** A full pass removes the rows it did not see (deleted on the provider's side). */
async function pruneCatalog(ctx: RunCtx, kind: KlaviyoCatalogResource, before: Date): Promise<void> {
  const where = { orgId: ctx.orgId, connectionId: ctx.connectionId, seenAt: { lt: before } };
  if (kind === 'lists' || kind === 'segments') {
    const audienceKind = kind === 'lists' ? 'list' : 'segment';
    const gone = await prisma.externalAudience.findMany({ where: { ...where, kind: audienceKind }, select: { externalId: true } });
    if (!gone.length) return;
    await prisma.externalAudience.deleteMany({ where: { ...where, kind: audienceKind } });
    // Their member cursors go with them (the members cascaded).
    await prisma.externalSyncState.deleteMany({
      where: { orgId: ctx.orgId, connectionId: ctx.connectionId, resource: { in: gone.map((g) => stateKey('members', g.externalId)) } },
    });
    for (const g of gone) ctx.states.delete(stateKey('members', g.externalId));
  } else if (kind === 'metrics') await prisma.externalMetric.deleteMany({ where });
  else if (kind === 'flows') await prisma.externalFlow.deleteMany({ where });
  else if (kind === 'campaigns') await prisma.externalCampaign.deleteMany({ where });
}

async function runCatalog(ctx: RunCtx, kind: KlaviyoCatalogResource): Promise<void> {
  const row = await stateFor(ctx, kind);
  if (!ctx.force && !isResourceDue(kind, passOf(row), ctx.clock())) return;
  const stop = await walk(
    ctx,
    kind,
    row,
    (pass) => catalogPath(kind, { since: pass.queryMode === 'incremental' ? pass.since : null, cursor: pass.pageCursor }),
    (page, seenAt) => {
      if (kind === 'lists') return applyAudiences(ctx, 'list', page.data, seenAt);
      if (kind === 'segments') return applyAudiences(ctx, 'segment', page.data, seenAt);
      if (kind === 'metrics') return applyMetrics(ctx, page.data, seenAt);
      if (kind === 'flows') return applyFlows(ctx, page.data, seenAt);
      return applyCampaigns(ctx, page.data, page.included, seenAt);
    },
    async (pruneBefore) => {
      if (pruneBefore) await pruneCatalog(ctx, kind, pruneBefore);
    },
  );
  await finish(ctx, row, stop);
}

// ── Members of lists and segments ────────────────────────────────────────────

async function runMembers(ctx: RunCtx, audience: { id: string; kind: string; externalId: string }): Promise<void> {
  const resource = stateKey('members', audience.externalId);
  const row = await stateFor(ctx, resource);
  if (!ctx.force && !isResourceDue('members', passOf(row), ctx.clock())) return;
  const kind = audience.kind === 'segment' ? 'segment' : 'list';
  const stop = await walk(
    ctx,
    'members',
    row,
    (pass) => membersPath({ kind, externalId: audience.externalId }, { since: pass.queryMode === 'incremental' ? pass.since : null, cursor: pass.pageCursor }),
    async (page, seenAt) => {
      let errors = 0;
      const members = [];
      for (const item of page.data) {
        const m = mapMember(item);
        if (m) members.push(m);
        else errors += 1;
      }
      const erased = await erasedProfileIds(ctx.orgId, members.map((m) => m.profileExternalId));
      const keep = members.filter((m) => !erased.has(m.profileExternalId));
      if (keep.length) {
        await prisma.$transaction(
          keep.map((m) =>
            prisma.externalAudienceMember.upsert({
              where: { audienceId_profileExternalId: { audienceId: audience.id, profileExternalId: m.profileExternalId } },
              create: { orgId: ctx.orgId, audienceId: audience.id, profileExternalId: m.profileExternalId, joinedAt: m.joinedAt, seenAt },
              update: { joinedAt: m.joinedAt, seenAt },
            }),
          ),
        );
      }
      return { count: keep.length, errors };
    },
    async (pruneBefore) => {
      // A full pass: whoever it did not see has left the list or segment.
      if (pruneBefore) {
        await prisma.externalAudienceMember.deleteMany({ where: { orgId: ctx.orgId, audienceId: audience.id, seenAt: { lt: pruneBefore } } });
      }
    },
  );
  await finish(ctx, row, stop);
}

// ── Events ───────────────────────────────────────────────────────────────────

async function runEvents(ctx: RunCtx, metric: { externalId: string }): Promise<void> {
  const resource = stateKey('events', metric.externalId);
  const row = await stateFor(ctx, resource);
  if (!ctx.force && !isResourceDue('events', passOf(row), ctx.clock())) return;
  // The window of a new pass is fixed when it begins and kept for every page
  // of it: the provider's page cursor belongs to that exact query. A daily
  // catch-up pass reaches back for late-delivered events (eventsWindowStart).
  if (!row.queryStartedAt) {
    const pass = beginPass('events', passOf(row), ctx.clock());
    await savePass(ctx, row, { ...pass, since: eventsWindowStart(pass, ctx.clock()) });
  }
  const stop = await walk(
    ctx,
    'events',
    row,
    (pass) => eventsPath(metric.externalId, { since: pass.since ?? eventRetentionCutoff(ctx.clock()), cursor: pass.pageCursor }),
    async (page) => {
      let errors = 0;
      const events = [];
      for (const item of page.data) {
        const e = mapEvent(item, metric.externalId);
        if (e) events.push(e);
        else errors += 1;
      }
      const erased = await erasedProfileIds(
        ctx.orgId,
        events.map((e) => e.profileExternalId).filter((id): id is string => Boolean(id)),
      );
      const keep = events.filter((e) => !e.profileExternalId || !erased.has(e.profileExternalId));
      if (!keep.length) return { count: 0, errors };
      const { count } = await prisma.externalEvent.createMany({
        data: keep.map((e) => ({ orgId: ctx.orgId, connectionId: ctx.connectionId, ...e })),
        skipDuplicates: true,
      });
      return { count, errors };
    },
  );
  await finish(ctx, row, stop);
}

// ── Campaign statistics (the reporting API) ──────────────────────────────────

async function runCampaignStats(ctx: RunCtx): Promise<void> {
  const row = await stateFor(ctx, 'campaign_stats');
  // Never forced: the reporting API allows 225 queries a day per account.
  if (!isResourceDue('campaign_stats', passOf(row), ctx.clock())) return;
  const campaigns = await prisma.externalCampaign.count({ where: { orgId: ctx.orgId, connectionId: ctx.connectionId } });
  if (!campaigns) return;
  const wanted = ((process.env.KLAVIYO_CONVERSION_METRIC || '').trim() || DEFAULT_CONVERSION_METRIC).toLowerCase();
  const metrics = await prisma.externalMetric.findMany({
    where: { orgId: ctx.orgId, connectionId: ctx.connectionId },
    select: { externalId: true, name: true },
    orderBy: { name: 'asc' },
  });
  // The query requires a conversion metric; without the configured one, any
  // metric serves and the conversion figures are simply not kept.
  const conversion = metrics.find((m) => m.name.toLowerCase() === wanted) ?? metrics[0];
  if (!conversion) return;
  const keepConversions = conversion.name.toLowerCase() === wanted;
  const computedAt = ctx.clock();
  let cursor: string | null = null;
  let count = 0;
  let errors = 0;
  let stop: Stop | null = null;
  for (let page = 0; page < CAMPAIGN_STATS_MAX_PAGES; page++) {
    const res = await klaviyoQuery(campaignStatsPath(cursor), ctx.key, campaignStatsQuery(conversion.externalId), req(ctx, 'campaign_stats'));
    if (!res.ok) {
      stop = { ok: false, code: res.code, retryAfterMs: res.retryAfterMs ?? null };
      break;
    }
    ctx.pagesLeft -= 1;
    const results = (res.data as { data?: { attributes?: { results?: unknown } } } | null)?.data?.attributes?.results;
    if (!Array.isArray(results)) {
      stop = { ok: false, code: 'bad_response' };
      break;
    }
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const r of results) {
      const s = mapCampaignStat(r);
      if (!s) {
        errors += 1;
        continue;
      }
      let statistics = s.statistics;
      if (!keepConversions) {
        const parsed = JSON.parse(statistics) as Record<string, number>;
        for (const k of Object.keys(parsed)) if (k.startsWith('conversion') || k === 'revenue_per_recipient') delete parsed[k];
        statistics = JSON.stringify(parsed);
      }
      const fields = { timeframe: CAMPAIGN_STATS_TIMEFRAME, recipients: s.recipients, statistics, computedAt };
      ops.push(
        prisma.externalCampaignStat.upsert({
          where: {
            connectionId_campaignExternalId_messageExternalId_channel: {
              connectionId: ctx.connectionId,
              campaignExternalId: s.campaignExternalId,
              messageExternalId: s.messageExternalId,
              channel: s.channel,
            },
          },
          create: {
            orgId: ctx.orgId,
            connectionId: ctx.connectionId,
            campaignExternalId: s.campaignExternalId,
            messageExternalId: s.messageExternalId,
            channel: s.channel,
            ...fields,
          },
          update: fields,
        }),
      );
    }
    if (ops.length) await prisma.$transaction(ops);
    count += ops.length;
    cursor = reportNextCursor(res.data);
    if (!cursor) break;
  }
  if (!stop) {
    // A finished report replaces yesterday's: a campaign that left the
    // timeframe has no figures any more, rather than stale ones.
    if (!cursor) {
      await prisma.externalCampaignStat.deleteMany({ where: { orgId: ctx.orgId, connectionId: ctx.connectionId, computedAt: { lt: computedAt } } });
    }
    await writeState(ctx, row, { lastFullAt: computedAt });
    stop = { ok: true, count, errors };
  }
  await finish(ctx, row, stop);
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface ResourceRunResult {
  outcome: 'ok' | 'partial' | 'error' | 'busy' | 'disabled' | 'missing';
  code?: KlaviyoErrorCode;
  resources: number;
  failed: number;
}

/**
 * One run of the non-profile resources of one connection. Never throws for a
 * provider failure — each resource records its own code and backoff.
 */
export async function runKlaviyoResources(
  connectionId: string,
  opts: { trigger: 'schedule' | 'manual'; now?: () => Date; client?: KlaviyoClientOptions } = { trigger: 'schedule' },
): Promise<ResourceRunResult> {
  const lease = klaviyoLeaseName(connectionId);
  const holder = `${replicaId().slice(0, 150)}:${randomUUID()}`;
  if (!(await acquireLease(lease, holder, KLAVIYO_LEASE_TTL_MS))) return { outcome: 'busy', resources: 0, failed: 0 };
  try {
    const row = await runWithOrg(null, () =>
      prisma.externalConnection.findUnique({ where: { id: connectionId }, select: { id: true, orgId: true, enabled: true, sealedKey: true } }),
    );
    if (!row) return { outcome: 'missing', resources: 0, failed: 0 };
    if (!row.enabled) return { outcome: 'disabled', resources: 0, failed: 0 };
    return await runWithOrg(row.orgId, () => runResourcesLocked(row, opts));
  } finally {
    await releaseLease(lease, holder);
  }
}

async function runResourcesLocked(
  row: { id: string; orgId: string; sealedKey: string },
  opts: { trigger: 'schedule' | 'manual'; now?: () => Date; client?: KlaviyoClientOptions },
): Promise<ResourceRunResult> {
  const { orgId } = row;
  if ((await verticalFor(orgId)) !== 'MARKETING') return { outcome: 'disabled', resources: 0, failed: 0 };
  const key = openConnectionKey(row.sealedKey);
  if (!key) return { outcome: 'error', code: 'key_unreadable', resources: 0, failed: 0 };
  const clock = opts.now ?? (() => new Date());
  const states = await prisma.externalSyncState.findMany({ where: { orgId, connectionId: row.id }, select: STATE_SELECT });
  const ctx: RunCtx = {
    orgId,
    connectionId: row.id,
    sealedKey: row.sealedKey,
    key,
    client: opts.client,
    clock,
    startedAt: clock().getTime(),
    pagesLeft: opts.trigger === 'manual' ? RESOURCE_PAGES_PER_MANUAL_RUN : RESOURCE_PAGES_PER_RUN,
    states: new Map(states.map((s) => [s.resource, s])),
    force: opts.trigger === 'manual',
  };

  const steps: (() => Promise<void>)[] = [
    // Metrics first (events and the statistics need them), audiences before members.
    ...(['metrics', 'lists', 'segments', 'flows', 'campaigns'] as const).map((kind) => () => runCatalog(ctx, kind)),
    async () => {
      const allow = eventMetricAllowlist(process.env.KLAVIYO_EVENT_METRICS);
      const metrics = await prisma.externalMetric.findMany({ where: { orgId, connectionId: row.id }, select: { externalId: true, name: true }, orderBy: { name: 'asc' } });
      for (const m of metrics) {
        if (!budgetLeft(ctx)) return;
        if (isEventMetricAllowed(m.name, allow)) await runEvents(ctx, m);
      }
    },
    async () => {
      const audiences = await prisma.externalAudience.findMany({
        where: { orgId, connectionId: row.id },
        select: { id: true, kind: true, externalId: true },
        orderBy: { name: 'asc' },
      });
      for (const a of audiences) {
        if (!budgetLeft(ctx)) return;
        await runMembers(ctx, a);
      }
    },
    () => runCampaignStats(ctx),
    async () => {
      // The retention sweep: an event leaves 13 months after it happened.
      await prisma.externalEvent.deleteMany({ where: { orgId, connectionId: row.id, occurredAt: { lt: eventRetentionCutoff(clock()) } } });
    },
  ];

  try {
    for (const step of steps) {
      if (!budgetLeft(ctx)) break;
      await step();
    }
  } catch (error) {
    if (error instanceof Superseded) return { outcome: 'missing', resources: ctx.states.size, failed: 0 };
    // The error's name only: a Prisma error's message can quote the call's arguments.
    logger.error('klaviyo resource sync threw', { connectionId: row.id, orgId, error: error instanceof Error ? error.name : 'unknown' });
    return { outcome: 'error', code: 'internal', resources: ctx.states.size, failed: 1 };
  }
  const after = await prisma.externalSyncState.findMany({ where: { orgId, connectionId: row.id }, select: { status: true } });
  const failed = after.filter((s) => s.status === 'error').length;
  const partial = after.some((s) => s.status === 'partial');
  return { outcome: failed ? 'partial' : partial ? 'partial' : 'ok', resources: after.length, failed };
}

// ── Reading it back (the admin card) ─────────────────────────────────────────

export interface ResourceStatus {
  resource: KlaviyoResourceKind;
  /** How many state rows this line sums (one per list/segment, per metric). */
  parts: number;
  lastOkAt: Date | null;
  lastRunAt: Date | null;
  status: 'ok' | 'partial' | 'error' | null;
  errorCode: string | null;
  failing: number;
  errors: number;
  rows: number;
  nextAttemptAt: Date | null;
}

/**
 * One line per resource kind: `members:*` and `events:*` are summed — the
 * oldest success, the worst status, how many parts fail — so a list of 300
 * segments is one line, not 300.
 */
export async function klaviyoResourceStatus(orgId: string, connectionId: string): Promise<ResourceStatus[]> {
  const rows = await prisma.externalSyncState.findMany({
    where: { orgId, connectionId },
    select: { resource: true, lastOkAt: true, lastRunAt: true, status: true, errorCode: true, lastErrors: true, nextAttemptAt: true },
  });
  const [audiences, members, metrics, events, campaigns, flows, stats] = await Promise.all([
    prisma.externalAudience.groupBy({ by: ['kind'], where: { orgId, connectionId }, _count: { _all: true } }),
    prisma.externalAudienceMember.count({ where: { orgId, audience: { connectionId } } }),
    prisma.externalMetric.count({ where: { orgId, connectionId } }),
    prisma.externalEvent.count({ where: { orgId, connectionId } }),
    prisma.externalCampaign.count({ where: { orgId, connectionId } }),
    prisma.externalFlow.count({ where: { orgId, connectionId } }),
    prisma.externalCampaignStat.count({ where: { orgId, connectionId } }),
  ]);
  const audienceCount = (kind: string) => audiences.find((a) => a.kind === kind)?._count._all ?? 0;
  const totals: Record<KlaviyoResourceKind, number> = {
    lists: audienceCount('list'),
    segments: audienceCount('segment'),
    members,
    metrics,
    events,
    campaigns,
    campaign_stats: stats,
    flows,
  };
  const rank = { ok: 0, partial: 1, error: 2 } as const;
  const order: KlaviyoResourceKind[] = ['lists', 'segments', 'members', 'metrics', 'events', 'campaigns', 'campaign_stats', 'flows'];
  return order.map((resource) => {
    const parts = rows.filter((r) => r.resource === resource || r.resource.startsWith(`${resource}:`));
    const worst = parts.reduce<ResourceStatus['status']>((w, p) => {
      const s = p.status as ResourceStatus['status'];
      return s && (!w || rank[s] > rank[w]) ? s : w;
    }, null);
    const failing = parts.filter((p) => p.status === 'error');
    const minDate = (ds: (Date | null)[]) => (ds.some((d) => !d) ? null : ds.reduce<Date | null>((m, d) => (d && (!m || d < m) ? d : m), null));
    const maxDate = (ds: (Date | null)[]) => ds.reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null);
    return {
      resource,
      parts: parts.length,
      lastOkAt: parts.length ? minDate(parts.map((p) => p.lastOkAt)) : null,
      lastRunAt: maxDate(parts.map((p) => p.lastRunAt)),
      status: worst,
      errorCode: failing[0]?.errorCode ?? null,
      failing: failing.length,
      errors: parts.reduce((n, p) => n + p.lastErrors, 0),
      rows: totals[resource],
      nextAttemptAt: maxDate(failing.map((p) => p.nextAttemptAt)),
    };
  });
}

/**
 * Everything this connector keeps beyond the profile links: removed when the
 * connection's key is replaced by a different one (it may be another account)
 * — the profile links follow their own rule in klaviyoSync.ts.
 */
export function resourceDataResetOps(tx: Prisma.TransactionClient, orgId: string, connectionId: string) {
  return [
    tx.externalSyncState.deleteMany({ where: { orgId, connectionId } }),
    tx.externalAudience.deleteMany({ where: { orgId, connectionId } }),
    tx.externalMetric.deleteMany({ where: { orgId, connectionId } }),
    tx.externalEvent.deleteMany({ where: { orgId, connectionId } }),
    tx.externalCampaign.deleteMany({ where: { orgId, connectionId } }),
    tx.externalCampaignStat.deleteMany({ where: { orgId, connectionId } }),
    tx.externalFlow.deleteMany({ where: { orgId, connectionId } }),
  ];
}
