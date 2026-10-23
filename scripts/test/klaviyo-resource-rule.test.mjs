// Unit tests for the Klaviyo connector's non-profile rules
// (src/lib/klaviyoResourceRule.ts): the paths it reads, the mapping of lists,
// segments, members, metrics, events, campaigns, statistics and flows onto
// their rows, and the schedule / pass that decides full vs incremental.
// Run: node --test --experimental-strip-types scripts/test/klaviyo-resource-rule.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_STATISTICS,
  DEFAULT_EVENT_METRICS,
  EVENT_PROPERTIES_MAX,
  RESOURCE_PAGE_SIZE,
  RESOURCE_SCHEDULE,
  RESOURCE_SINCE_OVERLAP_MS,
  afterResourcePage,
  beginPass,
  boundedEventProperties,
  campaignStatsPath,
  campaignStatsQuery,
  catalogPath,
  eventMetricAllowlist,
  eventRetentionCutoff,
  eventsPath,
  EVENT_CATCHUP_OVERLAP_MS,
  eventsWindowStart,
  isEventMetricAllowed,
  isResourceDue,
  isSafeId,
  kindOfStateKey,
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
} from '../../src/lib/klaviyoResourceRule.ts';

const url = (path) => new URL(`https://x.test${path}`);
const T0 = new Date('2026-10-22T10:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const fresh = () => ({ since: null, queryStartedAt: null, queryMode: null, pageCursor: null, lastFullAt: null, lastRunAt: null, nextAttemptAt: null });

// ── Paths ────────────────────────────────────────────────────────────────────

test('catalog paths: the right endpoint, fields, the updated filter only when incremental, the cursor', () => {
  const lists = url(catalogPath('lists', { since: null }));
  assert.equal(lists.pathname, '/api/lists');
  assert.equal(lists.searchParams.get('filter'), null);
  const incr = url(catalogPath('lists', { since: T0, cursor: 'c1' }));
  assert.equal(incr.searchParams.get('filter'), 'greater-than(updated,2026-10-22T10:00:00Z)');
  assert.equal(incr.searchParams.get('page[cursor]'), 'c1');

  assert.equal(url(catalogPath('segments', { since: T0 })).searchParams.get('filter'), 'greater-than(updated,2026-10-22T10:00:00Z)');
  assert.equal(url(catalogPath('metrics', { since: T0 })).searchParams.get('filter'), null); // no time filter on metrics

  const flows = url(catalogPath('flows', { since: T0 }));
  assert.equal(flows.searchParams.get('page[size]'), '50');
  assert.equal(flows.searchParams.get('sort'), 'updated');

  const campaigns = url(catalogPath('campaigns', { since: T0 }));
  assert.equal(campaigns.pathname, '/api/campaigns');
  assert.equal(campaigns.searchParams.get('include'), 'campaign-messages');
  assert.equal(campaigns.searchParams.get('filter'), 'greater-than(updated_at,2026-10-22T10:00:00Z)');
  assert.equal(campaigns.searchParams.get('page[size]'), '100');
  // 2026-10-15: no channel filter is required any more, and none is sent.
  assert.ok(!campaigns.searchParams.get('filter').includes('channel'));
});

test('members path: list or segment, ids only, joined_group_at filter and sort; an unsafe id never reaches a path', () => {
  const seg = url(membersPath({ kind: 'segment', externalId: 'SEG1' }, { since: null }));
  assert.equal(seg.pathname, '/api/segments/SEG1/profiles');
  assert.equal(seg.searchParams.get('page[size]'), String(RESOURCE_PAGE_SIZE.members));
  assert.equal(seg.searchParams.get('fields[profile]'), 'joined_group_at');
  assert.equal(seg.searchParams.get('sort'), 'joined_group_at');
  const list = url(membersPath({ kind: 'list', externalId: 'L_1' }, { since: T0, cursor: 'x' }));
  assert.equal(list.pathname, '/api/lists/L_1/profiles');
  assert.equal(list.searchParams.get('filter'), 'greater-than(joined_group_at,2026-10-22T10:00:00Z)');
  assert.throws(() => membersPath({ kind: 'list', externalId: '../profiles' }, { since: null }));
  assert.equal(isSafeId('abc/../x'), false);
  assert.equal(isSafeId('"x"'), false);
});

test('events path: one metric, after the window start, oldest first, page size 200', () => {
  const ev = url(eventsPath('M1', { since: T0 }));
  assert.equal(ev.pathname, '/api/events');
  assert.equal(ev.searchParams.get('filter'), 'equals(metric_id,"M1"),greater-than(datetime,2026-10-22T10:00:00Z)');
  assert.equal(ev.searchParams.get('sort'), 'datetime');
  assert.equal(ev.searchParams.get('page[size]'), '200');
  assert.throws(() => eventsPath('M1",x', { since: T0 }));
});

test('the reporting query asks for numbers only, over a year, with the conversion metric', () => {
  const q = campaignStatsQuery('M9');
  assert.equal(q.data.type, 'campaign-values-report');
  assert.equal(q.data.attributes.conversion_metric_id, 'M9');
  assert.deepEqual(q.data.attributes.timeframe, { key: 'last_365_days' });
  assert.deepEqual(q.data.attributes.statistics, [...CAMPAIGN_STATISTICS]);
  assert.equal(campaignStatsPath(null), '/api/campaign-values-reports');
  assert.equal(campaignStatsPath('a b'), '/api/campaign-values-reports?page_cursor=a%20b');
  assert.equal(reportNextCursor({ links: { next: 'https://a.klaviyo.com/api/campaign-values-reports?page_cursor=zz' } }), 'zz');
  assert.equal(reportNextCursor({ links: {} }), null);
});

// ── Mapping ──────────────────────────────────────────────────────────────────

test('lists and segments map to audiences; a resource without a usable id is refused', () => {
  const list = mapAudience({ type: 'list', id: 'L1', attributes: { name: ' Newsletter ', created: '2026-01-01T00:00:00Z', updated: '2026-02-01T00:00:00Z' } }, 'list');
  assert.deepEqual(list, {
    externalId: 'L1',
    kind: 'list',
    name: 'Newsletter',
    isActive: null,
    providerCreatedAt: new Date('2026-01-01T00:00:00Z'),
    providerUpdatedAt: new Date('2026-02-01T00:00:00Z'),
  });
  const seg = mapAudience({ id: 'S1', attributes: { name: 'VIP', is_active: true } }, 'segment');
  assert.equal(seg.isActive, true);
  assert.equal(mapAudience({ id: 'S2', attributes: {} }, 'segment').name, 'S2');
  assert.equal(mapAudience({ attributes: { name: 'x' } }, 'list'), null);
  assert.equal(mapAudience(null, 'list'), null);
});

test('members: profile id and joined_group_at — nothing else about the person', () => {
  assert.deepEqual(mapMember({ type: 'profile', id: 'P1', attributes: { joined_group_at: '2026-03-01T00:00:00Z', email: 'x@example.test' } }), {
    profileExternalId: 'P1',
    joinedAt: new Date('2026-03-01T00:00:00Z'),
  });
  assert.equal(mapMember({ id: 'P2' }).joinedAt, null);
});

test('metrics and flows map their fields', () => {
  assert.deepEqual(mapMetric({ id: 'M1', attributes: { name: 'Opened Email', integration: { name: 'Klaviyo', category: 'Internal' }, created: '2026-01-01T00:00:00Z' } }), {
    externalId: 'M1',
    name: 'Opened Email',
    integrationName: 'Klaviyo',
    integrationCategory: 'Internal',
    providerCreatedAt: new Date('2026-01-01T00:00:00Z'),
    providerUpdatedAt: null,
  });
  const flow = mapFlow({ id: 'F1', attributes: { name: 'Welcome', status: 'live', archived: false, trigger_type: 'Added to List', updated: '2026-05-01T00:00:00Z' } });
  assert.equal(flow.status, 'live');
  assert.equal(flow.triggerType, 'Added to List');
  assert.equal(flow.archived, false);
  assert.equal(mapFlow({ id: 'F2', attributes: {} }).archived, false);
});

test('campaigns (2026-10-15 omnichannel shape): definition, messages from included[] by relationship, never by position', () => {
  const resource = {
    type: 'campaign',
    id: 'C1',
    attributes: {
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-02T00:00:00Z',
      definition: { name: 'Autumn sale', archived: false, send_settings: { send_strategy: { method: 'static' } } },
    },
    relationships: { 'campaign-messages': { data: [{ type: 'campaign-message', id: 'CM1' }, { type: 'campaign-message', id: 'CM2' }] } },
  };
  const included = [
    { type: 'campaign-message', id: 'CMX', attributes: { definition: { name: 'other campaign', status: 'sent' } } },
    { type: 'campaign-message', id: 'CM2', attributes: { updated: '2026-09-03T00:00:00Z', definition: { name: 'SMS', status: 'scheduled', send_options: { send_time: '2026-10-01T09:00:00Z' } } } },
    { type: 'campaign-message', id: 'CM1', attributes: { definition: { name: 'Email', status: 'sent', send_options: { send_time: '2026-09-30T09:00:00Z' } } } },
    { type: 'tag', id: 'CM1' },
  ];
  const c = mapCampaign(resource, included);
  assert.equal(c.name, 'Autumn sale');
  assert.equal(c.sendStrategy, 'static');
  assert.deepEqual(c.messages.map((m) => m.externalId).sort(), ['CM1', 'CM2']);
  // The least-finished message decides: one is still scheduled.
  assert.equal(c.status, 'scheduled');
  assert.deepEqual(c.sendTime, new Date('2026-09-30T09:00:00Z'));
  assert.deepEqual(c.providerUpdatedAt, new Date('2026-09-02T00:00:00Z'));
});

test('campaigns (older flat shape) still map, so a deployment pinned to an older GA revision works', () => {
  const c = mapCampaign(
    { id: 'C2', attributes: { name: 'Old', status: 'Sent', archived: true, send_time: '2025-01-01T00:00:00Z', updated_at: '2025-01-02T00:00:00Z', send_strategy: { method: 'smart_send_time' } } },
    [],
  );
  assert.equal(c.name, 'Old');
  assert.equal(c.status, 'Sent');
  assert.equal(c.archived, true);
  assert.equal(c.sendStrategy, 'smart_send_time');
  assert.deepEqual(c.messages, []);
});

test('events: datetime, metric and profile from the relationships; properties bounded', () => {
  const e = mapEvent(
    {
      type: 'event',
      id: 'E1',
      attributes: { datetime: '2026-10-01T12:00:00+00:00', event_properties: { Subject: 'Hi', $value: 12.5, nested: { a: 1 } } },
      relationships: { profile: { data: { type: 'profile', id: 'P1' } }, metric: { data: { type: 'metric', id: 'M1' } } },
    },
    'M0',
  );
  assert.equal(e.externalId, 'E1');
  assert.equal(e.metricExternalId, 'M1');
  assert.equal(e.profileExternalId, 'P1');
  assert.deepEqual(e.occurredAt, new Date('2026-10-01T12:00:00Z'));
  assert.deepEqual(JSON.parse(e.properties), { Subject: 'Hi', $value: 12.5, nested: '{"a":1}' });
  // timestamp fallback, no profile, the queried metric
  const t = mapEvent({ id: 'E2', attributes: { timestamp: 1_760_000_000 } }, 'M0');
  assert.equal(t.metricExternalId, 'M0');
  assert.equal(t.profileExternalId, null);
  assert.equal(t.properties, null);
  assert.equal(mapEvent({ id: 'E3', attributes: {} }, 'M0'), null);
});

test('event properties: count, value and total size are bounded', () => {
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 'v'.repeat(1000)]));
  const text = boundedEventProperties(many);
  assert.ok(text.length <= EVENT_PROPERTIES_MAX);
  const parsed = JSON.parse(text);
  assert.ok(Object.keys(parsed).length <= 40);
  assert.ok(Object.values(parsed).every((v) => v.length <= 300));
  assert.equal(boundedEventProperties({}), null);
  assert.equal(boundedEventProperties('nope'), null);
});

test('campaign statistics: groupings + known numeric statistics only', () => {
  const s = mapCampaignStat({
    groupings: { campaign_id: 'C1', campaign_message_id: 'CM1', send_channel: 'email' },
    statistics: { recipients: 1000.0, open_rate: 0.42, made_up: 7, clicks_unique: 'x' },
  });
  assert.equal(s.campaignExternalId, 'C1');
  assert.equal(s.messageExternalId, 'CM1');
  assert.equal(s.channel, 'email');
  assert.equal(s.recipients, 1000);
  assert.deepEqual(JSON.parse(s.statistics), { recipients: 1000, open_rate: 0.42 });
  assert.equal(mapCampaignStat({ groupings: {} }), null);
  assert.equal(mapCampaignStat({ groupings: { campaign_id: 'C2' }, statistics: {} }).messageExternalId, '');
});

test('the event allowlist: engagement metrics by default, an override by name, * for all', () => {
  const def = eventMetricAllowlist(undefined);
  assert.ok(isEventMetricAllowed('Opened Email', def));
  assert.ok(isEventMetricAllowed('placed order', def));
  assert.ok(!isEventMetricAllowed('Received Email', def)); // the high-volume send log is not imported
  assert.ok(!isEventMetricAllowed('Active on Site', def));
  assert.equal(def.names.size, DEFAULT_EVENT_METRICS.length);
  const custom = eventMetricAllowlist(' Viewed Product , Started Checkout ');
  assert.ok(isEventMetricAllowed('Viewed Product', custom));
  assert.ok(!isEventMetricAllowed('Opened Email', custom));
  assert.ok(isEventMetricAllowed('Anything', eventMetricAllowlist('*')));
  assert.ok(!isEventMetricAllowed(null, def));
});

// ── Schedule and pass ────────────────────────────────────────────────────────

test('state keys: one per resource, one per list/segment for members, one per metric for events', () => {
  assert.equal(stateKey('lists'), 'lists');
  assert.equal(stateKey('members', 'S1'), 'members:S1');
  assert.equal(kindOfStateKey('events:M1'), 'events');
  assert.equal(kindOfStateKey('bogus:1'), null);
});

test('due: a new resource at once; an open pass always; a backed-off one not; else its schedule', () => {
  assert.equal(isResourceDue('lists', null, T0), true);
  const ran = { ...fresh(), since: T0, lastFullAt: T0, lastRunAt: T0 };
  assert.equal(isResourceDue('lists', ran, new Date(T0.getTime() + 5 * MIN)), false);
  assert.equal(isResourceDue('lists', ran, new Date(T0.getTime() + 15 * MIN)), true);
  assert.equal(isResourceDue('metrics', ran, new Date(T0.getTime() + HOUR)), false);
  assert.equal(isResourceDue('metrics', ran, new Date(T0.getTime() + 6 * HOUR)), true);
  assert.equal(isResourceDue('campaign_stats', ran, new Date(T0.getTime() + 23 * HOUR)), false);
  assert.equal(isResourceDue('lists', { ...ran, queryStartedAt: T0 }, new Date(T0.getTime() + MIN)), true);
  assert.equal(isResourceDue('lists', { ...ran, nextAttemptAt: new Date(T0.getTime() + HOUR) }, new Date(T0.getTime() + 30 * MIN)), false);
});

test('pass: the first is full; later ones incremental until a full one is due; metrics are always full', () => {
  const first = beginPass('lists', fresh(), T0);
  assert.equal(first.queryMode, 'full');
  assert.equal(first.queryStartedAt, T0);
  const done = afterResourcePage(first, null);
  assert.equal(done.passDone, true);
  assert.deepEqual(done.pruneBefore, T0); // a full pass removes what it did not see
  assert.deepEqual(done.state.since, new Date(T0.getTime() - RESOURCE_SINCE_OVERLAP_MS));
  assert.deepEqual(done.state.lastFullAt, T0);

  const later = beginPass('lists', done.state, new Date(T0.getTime() + HOUR));
  assert.equal(later.queryMode, 'incremental');
  const laterDone = afterResourcePage(later, null);
  assert.equal(laterDone.pruneBefore, null); // an incremental pass never prunes
  assert.deepEqual(laterDone.state.lastFullAt, T0);

  const nextDay = beginPass('lists', laterDone.state, new Date(T0.getTime() + RESOURCE_SCHEDULE.lists.fullEvery));
  assert.equal(nextDay.queryMode, 'full');

  assert.equal(beginPass('metrics', { ...done.state }, new Date(T0.getTime() + HOUR)).queryMode, 'full');
});

test('pass: a page with next stays in the pass; an open pass is continued, not restarted', () => {
  const open = beginPass('segments', fresh(), T0);
  const mid = afterResourcePage(open, 'cur2');
  assert.equal(mid.passDone, false);
  assert.equal(mid.state.pageCursor, 'cur2');
  assert.equal(mid.state.queryStartedAt, T0);
  assert.equal(beginPass('segments', mid.state, new Date(T0.getTime() + HOUR)), mid.state);
});

test('events: the first window starts at the 13-month retention cutoff; incremental passes continue; the daily catch-up reaches back', () => {
  const cutoff = eventRetentionCutoff(T0);
  assert.ok(T0.getTime() - cutoff.getTime() >= 395 * 24 * HOUR - 1);
  // First pass (full, nothing synced yet): the cutoff.
  const first = beginPass('events', fresh(), T0);
  assert.equal(first.queryMode, 'full');
  assert.deepEqual(eventsWindowStart(first, T0), cutoff);
  // Incremental: from where the last pass began, minus the overlap.
  const done = afterResourcePage({ ...first, since: cutoff }, null).state;
  const inc = beginPass('events', done, new Date(T0.getTime() + 15 * MIN));
  assert.equal(inc.queryMode, 'incremental');
  assert.deepEqual(eventsWindowStart(inc, T0), new Date(T0.getTime() - RESOURCE_SINCE_OVERLAP_MS));
  // A day later: the catch-up re-reads from the previous catch-up's start, minus an hour.
  const catchUp = beginPass('events', { ...done, since: new Date(T0.getTime() + 23 * HOUR) }, new Date(T0.getTime() + 24 * HOUR));
  assert.equal(catchUp.queryMode, 'full');
  assert.deepEqual(eventsWindowStart(catchUp, T0), new Date(T0.getTime() - EVENT_CATCHUP_OVERLAP_MS));
  // Never before the cutoff.
  assert.deepEqual(eventsWindowStart({ since: new Date('2020-01-01T00:00:00Z'), queryMode: 'incremental', lastFullAt: null }, T0), cutoff);
});
