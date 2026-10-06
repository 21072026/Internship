// Unit tests for src/lib/salesChannels.ts — the one sales-channel vocabulary (#2408).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SALES_CHANNELS,
  CHANNEL_STATUSES,
  channelLabel,
  channelsToAdd,
  isChannelKey,
  isChannelStatus,
  resolveChannel,
} from '../../src/lib/salesChannels.ts';

test('keys are unique, URL-safe and short enough for the column', () => {
  const keys = SALES_CHANNELS.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) {
    assert.match(key, /^[a-z0-9-]+$/);
    assert.ok(key.length <= 40, key);
  }
});

test('no alias resolves to two channels', () => {
  const seen = new Map();
  for (const c of SALES_CHANNELS) {
    for (const name of [c.key, c.label, ...(c.aliases ?? [])]) {
      const owner = resolveChannel(name);
      assert.equal(owner, c.key, `${name} resolves to ${owner}, not ${c.key}`);
      seen.set(name.toLowerCase(), c.key);
    }
  }
});

test('free text resolves however a spreadsheet spells it', () => {
  assert.equal(resolveChannel('Amazon FBA'), 'amazon');
  assert.equal(resolveChannel('  ebay.de '), 'ebay');
  assert.equal(resolveChannel('Shopware 6'), 'shopware');
  assert.equal(resolveChannel('TIKTOK_SHOP'), 'tiktok-shop');
  assert.equal(resolveChannel('Deutsche Post'), 'deutsche-post');
  assert.equal(resolveChannel('Wish'), null);
  assert.equal(resolveChannel(''), null);
});

test('labels and statuses', () => {
  assert.equal(channelLabel('otto'), 'OTTO');
  assert.equal(channelLabel('retired-marketplace'), 'retired-marketplace');
  assert.ok(isChannelKey('kaufland') && !isChannelKey('Kaufland'));
  assert.deepEqual([...CHANNEL_STATUSES], ['USING', 'INTERESTED', 'DROPPED']);
  assert.ok(isChannelStatus('DROPPED') && !isChannelStatus('using'));
});

test('an import only ever adds: it never removes or repeats', () => {
  assert.deepEqual(channelsToAdd(['amazon', 'otto', 'amazon'], ['otto', 'dhl']), ['amazon']);
  assert.deepEqual(channelsToAdd([], ['otto']), []);
});
