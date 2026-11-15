// Unit tests for the partner's campaign tags, monthly trend and earnings per
// click (src/lib/affiliateTrendRule.ts, src/lib/affiliateClickRule.ts,
// docs/affiliate-module.md § Campaign tags / § Trend and earnings per click,
// #3545). Synthetic dates only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { buildTrend, trendStart, monthKey, earningsPerClick, TREND_MONTHS } = await import('../../src/lib/affiliateTrendRule.ts');
const { parseCampaignTag, CAMPAIGN_TAG_RE, CAMPAIGNS_PER_PARTNER_DAY } = await import('../../src/lib/affiliateClickRule.ts');
const { FUNNEL_SORTS, sortFunnelRows } = await import('../../src/lib/affiliateFunnelBoardRule.ts');

const NOW = new Date('2026-05-14T10:00:00Z');

test('a campaign tag is a short word from a fixed alphabet, lower-cased; anything else is no tag', () => {
  assert.equal(parseCampaignTag('newsletter'), 'newsletter');
  assert.equal(parseCampaignTag(' YT-2026_spring '), 'yt-2026_spring');
  assert.equal(parseCampaignTag('x'.repeat(32)), 'x'.repeat(32));
  for (const bad of [null, undefined, '', '   ', 'x'.repeat(33), 'news letter', 'a/b', 'mail@x', 'ü', '<script>', 'a.b']) {
    assert.equal(parseCampaignTag(bad), null, String(bad));
  }
  assert.equal(CAMPAIGN_TAG_RE.test('ok-1'), true);
  assert.ok(CAMPAIGNS_PER_PARTNER_DAY > 0 && CAMPAIGNS_PER_PARTNER_DAY <= 100);
});

test('the trend is the current UTC month and the eleven before it, oldest first, none missing', () => {
  assert.equal(trendStart(NOW).toISOString(), '2025-06-01T00:00:00.000Z');
  const trend = buildTrend(NOW, [], []);
  assert.equal(trend.length, TREND_MONTHS);
  assert.equal(trend[0].month, '2025-06');
  assert.equal(trend.at(-1).month, '2026-05');
  assert.ok(trend.every((m) => m.clicks === 0 && m.registrations === 0 && m.paying === 0));
  // Across a year boundary in January.
  assert.equal(buildTrend(new Date('2026-01-31T23:59:59Z'), [], [])[0].month, '2025-02');
});

test('clicks fold by the UTC month of their day; customers by registration month, paying as a cohort', () => {
  const trend = buildTrend(
    NOW,
    [
      { day: new Date('2026-05-01T00:00:00Z'), clicks: 4 },
      { day: new Date('2026-05-13T00:00:00Z'), clicks: 6 },
      { day: new Date('2026-03-31T00:00:00Z'), clicks: 2 },
      { day: new Date('2025-05-31T00:00:00Z'), clicks: 99 }, // before the window
    ],
    [
      { createdAt: new Date('2026-03-02T08:00:00Z'), paying: true },
      { createdAt: new Date('2026-03-20T08:00:00Z'), paying: false },
      { createdAt: new Date('2026-05-31T23:59:59Z'), paying: false },
      { createdAt: new Date('2024-01-01T00:00:00Z'), paying: true }, // before the window
    ],
  );
  const by = Object.fromEntries(trend.map((m) => [m.month, m]));
  assert.deepEqual(by['2026-05'], { month: '2026-05', clicks: 10, registrations: 1, paying: 0 });
  assert.deepEqual(by['2026-03'], { month: '2026-03', clicks: 2, registrations: 2, paying: 1 });
  assert.equal(trend.reduce((n, m) => n + m.clicks, 0), 12);
  assert.equal(monthKey(new Date('2026-02-28T23:59:59Z')), '2026-02');
});

test('earnings per click: minor units, rounded; none without clicks', () => {
  assert.equal(earningsPerClick(1000, 3), 333);
  assert.equal(earningsPerClick(1000, 6), 167);
  assert.equal(earningsPerClick(0, 10), 0);
  assert.equal(earningsPerClick(500, 0), null);
  assert.equal(earningsPerClick(500, -1), null);
  assert.equal(earningsPerClick(500, Number.NaN), null);
});

test('the funnel board sorts by earnings per click, a row without clicks last both ways', () => {
  assert.ok(FUNNEL_SORTS.includes('earningsPerClick'));
  const row = (partnerId, earningsPerClick) => ({ partnerId, displayName: partnerId, earningsPerClick });
  const rows = [row('a', null), row('b', 120), row('c', 40)];
  assert.deepEqual(sortFunnelRows(rows, 'earningsPerClick', 'desc').map((r) => r.partnerId), ['b', 'c', 'a']);
  assert.deepEqual(sortFunnelRows(rows, 'earningsPerClick', 'asc').map((r) => r.partnerId), ['c', 'b', 'a']);
});
