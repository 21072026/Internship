// The Klaviyo connector's rules for everything that is not a profile
// (docs/integrations/klaviyo.md § Beyond profiles): lists, segments and their
// members, metrics, events, campaigns (+ their statistics) and flows.
//
// ZERO imports, like src/lib/klaviyoRule.ts, so the wire format, the mapping of
// each resource onto its row and the schedule are unit-tested without a
// database or a network (scripts/test/klaviyo-resource-rule.test.mjs). The
// Prisma half, and the only writer of these rows, is src/lib/klaviyoResources.ts.
//
// ── VERIFIED AGAINST THE PROVIDER'S REFERENCE, REVISION 2026-10-15 (2026-10-22)
//   GET /api/lists                      lists:read      ≤ 10/page   filter updated (greater-than)
//   GET /api/segments                   segments:read   ≤ 10/page   filter updated (greater-than)
//   GET /api/{lists|segments}/{id}/profiles
//                                       + profiles:read ≤ 100/page  filter/sort joined_group_at
//   GET /api/metrics                    metrics:read    ≤ 200/page  no time filter (read whole)
//   GET /api/events                     events:read     ≤ 200/page  filter metric_id + datetime, sort datetime
//   GET /api/campaigns                  campaigns:read  ≤ 100/page  filter updated_at, include campaign-messages
//   GET /api/flows                      flows:read      ≤ 50/page   filter updated
//   POST /api/campaign-values-reports   campaigns:read  a read-only QUERY; 2/min, 225/day
//   Steady limits differ per endpoint (flows 60/min, campaigns and metrics
//   150/min, lists/segments 750/min, events 3 500/min) — RESOURCE_PACE_MS.
//   2026-10-15 moved campaigns to the omnichannel model: the attributes sit
//   under `definition`, a message carries its own status. The mapping also
//   reads the pre-2026-10-15 flat shape, so a deployment pinned to an older
//   GA revision (KLAVIYO_REVISION) still maps.
//
// ── ONE-WAY ─────────────────────────────────────────────────────────────────
//   Every path built here is a GET, except the reporting query, whose POST
//   creates nothing on the provider's side.

// ── Resources and their schedule ─────────────────────────────────────────────

/** The catalog resources: read as a whole page set, each row upserted by its provider id. */
export const KLAVIYO_CATALOG_RESOURCES = ['lists', 'segments', 'metrics', 'flows', 'campaigns'] as const;
export type KlaviyoCatalogResource = (typeof KLAVIYO_CATALOG_RESOURCES)[number];

export const KLAVIYO_RESOURCE_KINDS = [...KLAVIYO_CATALOG_RESOURCES, 'members', 'events', 'campaign_stats'] as const;
export type KlaviyoResourceKind = (typeof KLAVIYO_RESOURCE_KINDS)[number];

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * How often each resource runs: `every` = an incremental pass (only what
 * changed since the last one), `fullEvery` = a full pass, which also removes
 * the rows the provider no longer has (a deletion is invisible to an
 * incremental `updated` filter). A resource the provider cannot filter by time
 * (metrics, the statistics) only ever runs full.
 */
export const RESOURCE_SCHEDULE: Record<KlaviyoResourceKind, { every: number; fullEvery: number; incremental: boolean }> = {
  lists: { every: 15 * MIN, fullEvery: 24 * HOUR, incremental: true },
  segments: { every: 15 * MIN, fullEvery: 24 * HOUR, incremental: true },
  flows: { every: 15 * MIN, fullEvery: 24 * HOUR, incremental: true },
  campaigns: { every: 15 * MIN, fullEvery: 24 * HOUR, incremental: true },
  metrics: { every: 6 * HOUR, fullEvery: 6 * HOUR, incremental: false },
  members: { every: HOUR, fullEvery: 24 * HOUR, incremental: true },
  // An events "full" pass is the daily CATCH-UP (eventsWindowStart), not a re-read of everything.
  events: { every: 15 * MIN, fullEvery: 24 * HOUR, incremental: true },
  campaign_stats: { every: 24 * HOUR, fullEvery: 24 * HOUR, incremental: false },
};

/**
 * The minimum gap between two requests of one resource family, in one process:
 * comfortably under the provider's steady limit (60 000 / limit per minute).
 */
export const RESOURCE_PACE_MS: Record<string, number> = {
  lists: 100,
  segments: 100,
  members: 100,
  metrics: 450,
  events: 50,
  campaigns: 450,
  flows: 1100,
  campaign_stats: 31_000,
};

/** Page sizes: each endpoint's maximum (lists/segments are fixed at 10). */
export const RESOURCE_PAGE_SIZE = {
  lists: 10,
  segments: 10,
  members: 100,
  metrics: 200,
  events: 200,
  campaigns: 100,
  flows: 50,
} as const;

/** Page budgets of one run, all resources together, and per resource. */
export const RESOURCE_PAGES_PER_RUN = 120;
export const RESOURCE_PAGES_PER_MANUAL_RUN = 20;
export const RESOURCE_PAGES_PER_RESOURCE = 30;
/** A run of the non-profile resources stops starting pages after this long. */
export const RESOURCE_RUN_TIME_BUDGET_MS = 4 * MIN;

/** The overlap an incremental pass re-reads (clock skew, rows saved mid-pass). */
export const RESOURCE_SINCE_OVERLAP_MS = 5 * MIN;

/** Events older than this are neither imported nor kept (the retention sweep). */
export const EVENT_RETENTION_DAYS = 395; // 13 months
export function eventRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - EVENT_RETENTION_DAYS * 24 * HOUR);
}

/**
 * The metrics whose events are imported, by name. Not every event: an account
 * records page views and every e-mail it sends, millions a month; the CRM
 * keeps the engagement and conversion signals. `KLAVIYO_EVENT_METRICS`
 * (comma-separated names) replaces the list; `*` imports every metric.
 */
export const DEFAULT_EVENT_METRICS = [
  'Opened Email',
  'Clicked Email',
  'Bounced Email',
  'Marked Email as Spam',
  'Unsubscribed',
  'Unsubscribed from Email Marketing',
  'Subscribed to Email Marketing',
  'Subscribed to List',
  'Submitted Form',
  'Placed Order',
] as const;

export function eventMetricAllowlist(raw: string | null | undefined): { all: boolean; names: Set<string> } {
  const v = (raw ?? '').trim();
  if (v === '*') return { all: true, names: new Set() };
  const names = v
    ? v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_EVENT_METRICS.map((s) => s.toLowerCase());
  return { all: false, names: new Set(names) };
}

export function isEventMetricAllowed(name: string | null | undefined, allow: { all: boolean; names: Set<string> }): boolean {
  if (allow.all) return true;
  return Boolean(name) && allow.names.has(String(name).trim().toLowerCase());
}

/** The metric whose conversions the campaign statistics count (overridable by name). */
export const DEFAULT_CONVERSION_METRIC = 'Placed Order';

/** The campaign statistics asked for — counts and rates, never anything about a person. */
export const CAMPAIGN_STATISTICS = [
  'recipients',
  'delivered',
  'delivery_rate',
  'opens_unique',
  'open_rate',
  'clicks_unique',
  'click_rate',
  'click_to_open_rate',
  'bounced',
  'bounce_rate',
  'unsubscribes',
  'unsubscribe_rate',
  'spam_complaints',
  'spam_complaint_rate',
  'conversions',
  'conversion_uniques',
  'conversion_value',
  'conversion_rate',
  'revenue_per_recipient',
] as const;
export const CAMPAIGN_STATS_TIMEFRAME = 'last_365_days';
/** The reporting query is paged rarely; three pages is plenty and stays inside 2/min. */
export const CAMPAIGN_STATS_MAX_PAGES = 3;

/** The state key of one resource: `lists`, or `members:<list-or-segment id>`, `events:<metric id>`. */
export function stateKey(kind: KlaviyoResourceKind, externalId?: string): string {
  return externalId ? `${kind}:${externalId}` : kind;
}

export function kindOfStateKey(key: string): KlaviyoResourceKind | null {
  const kind = key.split(':')[0];
  return (KLAVIYO_RESOURCE_KINDS as readonly string[]).includes(kind) ? (kind as KlaviyoResourceKind) : null;
}

// ── The pass (cursor) ────────────────────────────────────────────────────────

export interface PassState {
  /** An incremental pass reads rows changed after this; null = never synced. */
  since: Date | null;
  /** When the open pass began; null = no pass open. */
  queryStartedAt: Date | null;
  queryMode: 'full' | 'incremental' | null;
  pageCursor: string | null;
  lastFullAt: Date | null;
  lastRunAt: Date | null;
  nextAttemptAt: Date | null;
}

/**
 * Whether a resource is due now: an open pass always continues (unless backed
 * off); otherwise its schedule decides. A resource never run is due at once.
 */
export function isResourceDue(kind: KlaviyoResourceKind, state: PassState | null, now: Date): boolean {
  if (state?.nextAttemptAt && state.nextAttemptAt.getTime() > now.getTime()) return false;
  if (!state || state.queryStartedAt) return true;
  const s = RESOURCE_SCHEDULE[kind];
  if (!state.lastFullAt || now.getTime() - state.lastFullAt.getTime() >= s.fullEvery) return true;
  return !state.lastRunAt || now.getTime() - state.lastRunAt.getTime() >= s.every;
}

/**
 * The state at the start of a pass: an open pass continues; else a full pass
 * when one is due (or the resource cannot run incrementally), an incremental
 * one otherwise.
 */
export function beginPass(kind: KlaviyoResourceKind, state: PassState, now: Date): PassState {
  if (state.queryStartedAt) return state;
  const s = RESOURCE_SCHEDULE[kind];
  const fullDue = !s.incremental || !state.since || !state.lastFullAt || now.getTime() - state.lastFullAt.getTime() >= s.fullEvery;
  return { ...state, queryStartedAt: now, queryMode: fullDue ? 'full' : 'incremental', pageCursor: null };
}

/**
 * The state after one page. A page with a `next` stays in the pass; the last
 * page closes it: the next incremental pass reads what changed since this one
 * BEGAN minus the overlap, and a full pass stamps `lastFullAt` (the caller
 * then removes the rows this pass did not see — `pruneBefore`).
 */
export function afterResourcePage(
  state: PassState,
  nextCursor: string | null,
): { state: PassState; passDone: boolean; pruneBefore: Date | null } {
  if (nextCursor) return { state: { ...state, pageCursor: nextCursor }, passDone: false, pruneBefore: null };
  const began = state.queryStartedAt ?? new Date();
  const full = state.queryMode === 'full';
  return {
    state: {
      ...state,
      since: new Date(began.getTime() - RESOURCE_SINCE_OVERLAP_MS),
      queryStartedAt: null,
      queryMode: null,
      pageCursor: null,
      lastFullAt: full ? began : state.lastFullAt,
    },
    passDone: true,
    pruneBefore: full ? began : null,
  };
}

/**
 * Where an events pass starts reading. Events are append-only and never pruned
 * by a pass; the provider filters them by WHEN THEY HAPPENED (`datetime`), not
 * by when it received them, and an integration may deliver an event hours
 * late (an order synced from a shop, say). So:
 *
 *   • an incremental pass (every 15 min) reads from where the last one began,
 *     minus the overlap — cheap, and complete for events that arrive on time;
 *   • once a day the catch-up pass re-reads from where the PREVIOUS catch-up
 *     began, minus EVENT_CATCHUP_OVERLAP_MS — so an event that arrived up to a
 *     day late is still picked up. Re-read events are skipped (skipDuplicates).
 *
 * Neither ever reaches before the retention cutoff, and the first pass starts
 * there, not at the beginning of time. An event delivered more than a day
 * after it happened can be missed — the documented limit.
 */
export const EVENT_CATCHUP_OVERLAP_MS = HOUR;
export function eventsWindowStart(pass: Pick<PassState, 'since' | 'queryMode' | 'lastFullAt'>, now: Date): Date {
  const floor = eventRetentionCutoff(now);
  const start =
    pass.queryMode === 'full'
      ? pass.lastFullAt
        ? new Date(pass.lastFullAt.getTime() - EVENT_CATCHUP_OVERLAP_MS)
        : floor
      : pass.since;
  return start && start > floor ? start : floor;
}

// ── Paths ────────────────────────────────────────────────────────────────────

function instant(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A provider id as it may appear inside a path or a quoted filter value. */
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function withCursor(params: URLSearchParams, cursor: string | null | undefined): string {
  if (cursor) params.set('page[cursor]', cursor);
  return params.toString();
}

export function catalogPath(kind: KlaviyoCatalogResource, opts: { since: Date | null; cursor?: string | null }): string {
  const p = new URLSearchParams();
  switch (kind) {
    case 'lists':
      p.set('fields[list]', 'name,created,updated,opt_in_process');
      if (opts.since) p.set('filter', `greater-than(updated,${instant(opts.since)})`);
      return `/api/lists?${withCursor(p, opts.cursor)}`;
    case 'segments':
      p.set('fields[segment]', 'name,created,updated,is_active,is_starred');
      if (opts.since) p.set('filter', `greater-than(updated,${instant(opts.since)})`);
      return `/api/segments?${withCursor(p, opts.cursor)}`;
    case 'metrics':
      p.set('fields[metric]', 'name,created,updated,integration');
      return `/api/metrics?${withCursor(p, opts.cursor)}`;
    case 'flows':
      p.set('page[size]', String(RESOURCE_PAGE_SIZE.flows));
      p.set('fields[flow]', 'name,status,archived,trigger_type,created,updated');
      if (opts.since) p.set('filter', `greater-than(updated,${instant(opts.since)})`);
      p.set('sort', 'updated');
      return `/api/flows?${withCursor(p, opts.cursor)}`;
    case 'campaigns':
      p.set('page[size]', String(RESOURCE_PAGE_SIZE.campaigns));
      p.set('include', 'campaign-messages');
      if (opts.since) p.set('filter', `greater-than(updated_at,${instant(opts.since)})`);
      p.set('sort', 'updated_at');
      return `/api/campaigns?${withCursor(p, opts.cursor)}`;
  }
}

/** The members of one list or segment: profile ids and when they joined, nothing else. */
export function membersPath(audience: { kind: 'list' | 'segment'; externalId: string }, opts: { since: Date | null; cursor?: string | null }): string {
  if (!isSafeId(audience.externalId)) throw new Error('unsafe audience id');
  const p = new URLSearchParams();
  p.set('page[size]', String(RESOURCE_PAGE_SIZE.members));
  p.set('fields[profile]', 'joined_group_at');
  if (opts.since) p.set('filter', `greater-than(joined_group_at,${instant(opts.since)})`);
  p.set('sort', 'joined_group_at');
  return `/api/${audience.kind === 'list' ? 'lists' : 'segments'}/${audience.externalId}/profiles?${withCursor(p, opts.cursor)}`;
}

/** One metric's events after `since`, oldest first, with the profile id as a relationship. */
export function eventsPath(metricExternalId: string, opts: { since: Date; cursor?: string | null }): string {
  if (!isSafeId(metricExternalId)) throw new Error('unsafe metric id');
  const p = new URLSearchParams();
  p.set('page[size]', String(RESOURCE_PAGE_SIZE.events));
  p.set('fields[event]', 'datetime,event_properties');
  p.set('filter', `equals(metric_id,"${metricExternalId}"),greater-than(datetime,${instant(opts.since)})`);
  p.set('sort', 'datetime');
  return `/api/events?${withCursor(p, opts.cursor)}`;
}

/** The reporting query (POSTed to /api/campaign-values-reports). */
export function campaignStatsQuery(conversionMetricId: string) {
  return {
    data: {
      type: 'campaign-values-report',
      attributes: {
        statistics: [...CAMPAIGN_STATISTICS],
        timeframe: { key: CAMPAIGN_STATS_TIMEFRAME },
        conversion_metric_id: conversionMetricId,
      },
    },
  };
}

export function campaignStatsPath(cursor?: string | null): string {
  return cursor ? `/api/campaign-values-reports?page_cursor=${encodeURIComponent(cursor)}` : '/api/campaign-values-reports';
}

/** The reporting API pages with `page_cursor` (not `page[cursor]`). */
export function reportNextCursor(body: unknown): string | null {
  const next = (body as { links?: { next?: unknown } } | null)?.links?.next;
  if (typeof next !== 'string' || !next) return null;
  try {
    const u = new URL(next, 'https://a.klaviyo.com');
    const c = u.searchParams.get('page_cursor') ?? u.searchParams.get('page[cursor]');
    return c && c.length <= 2000 ? c : null;
  } catch {
    return null;
  }
}

// ── The mapping ──────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function date(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

export interface AudienceRow {
  externalId: string;
  kind: 'list' | 'segment';
  name: string;
  isActive: boolean | null;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
}

export function mapAudience(resource: unknown, kind: 'list' | 'segment'): AudienceRow | null {
  const r = obj(resource);
  if (!isSafeId(r.id)) return null;
  const a = obj(r.attributes);
  return {
    externalId: r.id,
    kind,
    name: str(a.name, 255) ?? r.id,
    isActive: kind === 'segment' ? bool(a.is_active) : null,
    providerCreatedAt: date(a.created),
    providerUpdatedAt: date(a.updated),
  };
}

export interface MetricRow {
  externalId: string;
  name: string;
  integrationName: string | null;
  integrationCategory: string | null;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
}

export function mapMetric(resource: unknown): MetricRow | null {
  const r = obj(resource);
  if (!isSafeId(r.id)) return null;
  const a = obj(r.attributes);
  const integration = obj(a.integration);
  return {
    externalId: r.id,
    name: str(a.name, 255) ?? r.id,
    integrationName: str(integration.name, 120),
    integrationCategory: str(integration.category, 120),
    providerCreatedAt: date(a.created),
    providerUpdatedAt: date(a.updated),
  };
}

export interface FlowRow {
  externalId: string;
  name: string;
  status: string | null;
  archived: boolean;
  triggerType: string | null;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
}

export function mapFlow(resource: unknown): FlowRow | null {
  const r = obj(resource);
  if (!isSafeId(r.id)) return null;
  const a = obj(r.attributes);
  return {
    externalId: r.id,
    name: str(a.name, 255) ?? r.id,
    status: str(a.status, 20),
    archived: bool(a.archived) ?? false,
    triggerType: str(a.trigger_type, 40),
    providerCreatedAt: date(a.created),
    providerUpdatedAt: date(a.updated),
  };
}

export interface CampaignMessageRow {
  externalId: string;
  name: string | null;
  status: string | null;
  channel: string | null;
  sendTime: Date | null;
  providerUpdatedAt: Date | null;
}

export interface CampaignRow {
  externalId: string;
  name: string;
  archived: boolean;
  status: string | null;
  sendStrategy: string | null;
  sendTime: Date | null;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  messages: CampaignMessageRow[];
}

function mapCampaignMessage(resource: unknown): CampaignMessageRow | null {
  const r = obj(resource);
  if (!isSafeId(r.id)) return null;
  const a = obj(r.attributes);
  // 2026-10-15: everything sits under `definition`; earlier: flat.
  const d = Object.keys(obj(a.definition)).length ? obj(a.definition) : a;
  const send = obj(d.send_options);
  const content = obj(d.content);
  return {
    externalId: r.id,
    name: str(d.name, 255) ?? str(d.label, 255) ?? str(content.subject, 255),
    status: str(d.status, 20),
    channel: str(d.channel, 30) ?? str(a.channel, 30),
    sendTime: date(send.send_time) ?? date(a.send_time),
    providerUpdatedAt: date(a.updated) ?? date(a.updated_at),
  };
}

/**
 * One campaign with its messages from `included[]`. The messages are matched by
 * the campaign's `relationships['campaign-messages']`, never by position.
 */
export function mapCampaign(resource: unknown, included: unknown[]): CampaignRow | null {
  const r = obj(resource);
  if (!isSafeId(r.id)) return null;
  const a = obj(r.attributes);
  const d = Object.keys(obj(a.definition)).length ? obj(a.definition) : a;
  const sendSettings = obj(d.send_settings);
  const strategy = obj(d.send_strategy ?? sendSettings.send_strategy);
  const relIds = new Set(
    ((obj(obj(r.relationships)['campaign-messages']).data as unknown[]) ?? [])
      .map((x) => obj(x).id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const messages = included
    .filter((x) => obj(x).type === 'campaign-message' && relIds.has(String(obj(x).id)))
    .map(mapCampaignMessage)
    .filter((m): m is CampaignMessageRow => Boolean(m));
  return {
    externalId: r.id,
    name: str(d.name, 255) ?? r.id,
    archived: bool(d.archived) ?? false,
    status: str(a.status, 20) ?? (messages.length ? summaryStatus(messages) : null),
    sendStrategy: str(strategy.method, 40) ?? str(d.send_strategy, 40),
    sendTime: date(a.send_time) ?? date(a.scheduled_at) ?? earliest(messages.map((m) => m.sendTime)),
    providerCreatedAt: date(a.created_at) ?? date(a.created),
    providerUpdatedAt: date(a.updated_at) ?? date(a.updated),
    messages,
  };
}

const STATUS_ORDER = ['sending', 'scheduled', 'draft', 'sent', 'cancelled'];
/** A campaign's status under the omnichannel model: its least-finished message's. */
function summaryStatus(messages: CampaignMessageRow[]): string | null {
  const statuses = messages.map((m) => (m.status ?? '').toLowerCase());
  return STATUS_ORDER.find((s) => statuses.includes(s)) ?? messages[0]?.status ?? null;
}

function earliest(dates: (Date | null)[]): Date | null {
  return dates.reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);
}

export interface MemberRow {
  profileExternalId: string;
  joinedAt: Date | null;
}

export function mapMember(resource: unknown): MemberRow | null {
  const r = obj(resource);
  if (!isSafeId(r.id)) return null;
  return { profileExternalId: r.id, joinedAt: date(obj(r.attributes).joined_group_at) };
}

/** The event properties kept, as bounded JSON text (like a profile's attributes). */
export const EVENT_PROPERTIES_MAX = 4000;
const EVENT_PROPERTY_LIMIT = 40;
const EVENT_VALUE_MAX = 300;

/**
 * Bounded copy of an event's properties: at most EVENT_PROPERTY_LIMIT keys,
 * scalars only (a nested object or array becomes its JSON, cut to
 * EVENT_VALUE_MAX), the whole text at most EVENT_PROPERTIES_MAX characters —
 * keys dropped from the end until it fits.
 */
export function boundedEventProperties(props: unknown): string | null {
  const src = obj(props);
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(src).slice(0, EVENT_PROPERTY_LIMIT)) {
    const key = k.slice(0, 64);
    if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = v.slice(0, EVENT_VALUE_MAX);
    else if (v !== null && v !== undefined) out[key] = JSON.stringify(v).slice(0, EVENT_VALUE_MAX);
  }
  const keys = Object.keys(out);
  if (!keys.length) return null;
  let text = JSON.stringify(out);
  while (text.length > EVENT_PROPERTIES_MAX && keys.length) {
    delete out[keys.pop()!];
    text = JSON.stringify(out);
  }
  return keys.length ? text : null;
}

export interface EventRow {
  externalId: string;
  metricExternalId: string;
  profileExternalId: string | null;
  occurredAt: Date;
  properties: string | null;
}

export function mapEvent(resource: unknown, metricExternalId: string): EventRow | null {
  const r = obj(resource);
  if (!isSafeId(r.id)) return null;
  const a = obj(r.attributes);
  const occurredAt = date(a.datetime) ?? (typeof a.timestamp === 'number' ? new Date(a.timestamp * 1000) : null);
  if (!occurredAt) return null;
  const rel = obj(r.relationships);
  const profileId = obj(obj(rel.profile).data).id;
  const metricId = obj(obj(rel.metric).data).id;
  return {
    externalId: r.id,
    metricExternalId: isSafeId(metricId) ? metricId : metricExternalId,
    profileExternalId: isSafeId(profileId) ? profileId : null,
    occurredAt,
    properties: boundedEventProperties(a.event_properties),
  };
}

export interface CampaignStatRow {
  campaignExternalId: string;
  messageExternalId: string;
  channel: string;
  recipients: number | null;
  statistics: string;
}

/** One result row of the reporting query: groupings + numbers only. */
export function mapCampaignStat(result: unknown): CampaignStatRow | null {
  const r = obj(result);
  const g = obj(r.groupings);
  if (!isSafeId(g.campaign_id)) return null;
  const stats: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(r.statistics))) {
    if ((CAMPAIGN_STATISTICS as readonly string[]).includes(k) && typeof v === 'number' && Number.isFinite(v)) stats[k] = v;
  }
  return {
    campaignExternalId: g.campaign_id,
    messageExternalId: isSafeId(g.campaign_message_id) ? g.campaign_message_id : '',
    channel: str(g.send_channel, 30) ?? '',
    recipients: typeof stats.recipients === 'number' ? Math.round(stats.recipients) : null,
    statistics: JSON.stringify(stats),
  };
}
