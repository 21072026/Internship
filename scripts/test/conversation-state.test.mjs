// Per-viewer inbox state (#1609) — archive / mute / pin rules. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MUTE_FOREVER,
  filterInbox,
  isArchived,
  isMuted,
  muteUntil,
  parseInboxFilter,
  sortInbox,
} from '../../src/lib/conversationState.ts';

const NOW = new Date('2026-10-06T12:00:00Z');
const at = (iso) => new Date(iso);
const state = (s = {}) => ({ archivedAt: null, mutedUntil: null, pinnedAt: null, ...s });

test('mute lengths, and forever is one far-future comparison', () => {
  assert.equal(muteUntil('8h', NOW).toISOString(), '2026-10-06T20:00:00.000Z');
  assert.equal(muteUntil('1w', NOW).toISOString(), '2026-10-13T12:00:00.000Z');
  assert.equal(muteUntil('forever', NOW), MUTE_FOREVER);
  assert.equal(isMuted(MUTE_FOREVER, NOW), true);
});

test('a mute ends at mutedUntil', () => {
  assert.equal(isMuted(null, NOW), false);
  assert.equal(isMuted(at('2026-10-06T12:00:01Z'), NOW), true);
  assert.equal(isMuted(at('2026-10-06T12:00:00Z'), NOW), false);
  assert.equal(isMuted('2026-10-05T00:00:00Z', NOW), false);
});

test('archived until someone else writes — unless the thread is muted', () => {
  const archivedAt = at('2026-10-05T10:00:00Z');
  const me = 'me';
  assert.equal(isArchived(state(), null, me, NOW), false);
  assert.equal(isArchived(state({ archivedAt }), null, me, NOW), true);
  // An older message, or my own newer one, leaves it archived.
  assert.equal(isArchived(state({ archivedAt }), { senderId: 'them', createdAt: at('2026-10-05T09:00:00Z') }, me, NOW), true);
  assert.equal(isArchived(state({ archivedAt }), { senderId: me, createdAt: at('2026-10-05T11:00:00Z') }, me, NOW), true);
  // Someone else wrote since: back in the list…
  const fresh = { senderId: 'them', createdAt: at('2026-10-05T11:00:00Z') };
  assert.equal(isArchived(state({ archivedAt }), fresh, me, NOW), false);
  // …unless it is muted, which is how a noisy room stays archived.
  assert.equal(isArchived(state({ archivedAt, mutedUntil: MUTE_FOREVER }), fresh, me, NOW), true);
  // An expired mute no longer holds it there.
  assert.equal(isArchived(state({ archivedAt, mutedUntil: at('2026-10-06T00:00:00Z') }), fresh, me, NOW), false);
});

test('filter parsing falls back to all', () => {
  assert.equal(parseInboxFilter('unread'), 'unread');
  assert.equal(parseInboxFilter('archived'), 'archived');
  assert.equal(parseInboxFilter(undefined), 'all');
  assert.equal(parseInboxFilter('everything'), 'all');
});

const row = (id, o = {}) => ({ id, pinned: false, archived: false, unread: 0, last: null, ...o });
const ids = (rows) => rows.map((r) => r.id);

test('pinned first, then latest message; ties keep their order', () => {
  const rows = [
    row('old', { last: { createdAt: at('2026-10-01T00:00:00Z') } }),
    row('new', { last: { createdAt: at('2026-10-06T00:00:00Z') } }),
    row('pinnedOld', { pinned: true, last: { createdAt: at('2026-09-01T00:00:00Z') } }),
    row('empty'),
    row('pinnedNew', { pinned: true, last: { createdAt: at('2026-10-02T00:00:00Z') } }),
  ];
  assert.deepEqual(ids(sortInbox(rows)), ['pinnedNew', 'pinnedOld', 'new', 'old', 'empty']);
});

test('only the Archived chip shows archived threads', () => {
  const rows = [
    row('a'),
    row('unread', { unread: 2 }),
    row('pinned', { pinned: true }),
    row('archived', { archived: true, unread: 3, pinned: true }),
  ];
  assert.deepEqual(ids(filterInbox(rows, 'all')), ['a', 'unread', 'pinned']);
  assert.deepEqual(ids(filterInbox(rows, 'unread')), ['unread']);
  assert.deepEqual(ids(filterInbox(rows, 'pinned')), ['pinned']);
  assert.deepEqual(ids(filterInbox(rows, 'archived')), ['archived']);
});
