// Message thread paging (#1609) — cursor, page split, merge, snippet. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_PAGE_DEFAULT,
  MESSAGE_PAGE_MAX,
  decodePageCursor,
  encodePageCursor,
  likeLiteral,
  mergeNewestPage,
  olderThan,
  parsePageLimit,
  prependOlderPage,
  searchSnippet,
  toPage,
} from '../../src/lib/messagePage.ts';

const T0 = Date.UTC(2026, 0, 1);
// A thread of n messages, oldest first, one minute apart; ids sort with time.
const thread = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `m${String(from + i).padStart(5, '0')}`, createdAt: new Date(T0 + (from + i) * 60_000).toISOString() }));
const ids = (rows) => rows.map((r) => r.id);

test('limit: default 50, clamped to 1..100, garbage is the default', () => {
  assert.equal(parsePageLimit(null), MESSAGE_PAGE_DEFAULT);
  assert.equal(parsePageLimit(''), 50);
  assert.equal(parsePageLimit('abc'), 50);
  assert.equal(parsePageLimit('20'), 20);
  assert.equal(parsePageLimit('0'), 1);
  assert.equal(parsePageLimit('-5'), 1);
  assert.equal(parsePageLimit('5000'), MESSAGE_PAGE_MAX);
  assert.equal(parsePageLimit('12.9'), 12);
});

test('cursor round-trips and refuses anything else', () => {
  const row = { id: 'clx9abc123', createdAt: new Date(T0) };
  const c = encodePageCursor(row);
  assert.deepEqual(decodePageCursor(c), { id: 'clx9abc123', createdAt: new Date(T0) });
  for (const bad of [null, '', 'x', '123', '123_', '_abc', '12_ab-c', `${T0}_a b`, '1'.repeat(16) + '_a', "1_a'; DROP"]) {
    assert.equal(decodePageCursor(bad), null, String(bad));
  }
});

test('olderThan is strict keyset order, ties broken by id', () => {
  const c = { createdAt: new Date(T0), id: 'm5' };
  assert.deepEqual(olderThan(c), { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: 'm5' } }] });
});

test('toPage: reading order, hasMore and the cursor of the oldest row', () => {
  const all = thread(120);
  const newestFirst = [...all].reverse();
  const first = toPage(newestFirst.slice(0, 51), 50);
  assert.equal(first.messages.length, 50);
  assert.deepEqual(ids(first.messages), ids(all.slice(70)));
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, encodePageCursor(all[70]));
  const last = toPage(newestFirst.slice(100, 120), 50);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextCursor, null);
  assert.deepEqual(ids(last.messages), ids(all.slice(0, 20)));
});

// Simulate the server: keyset read of one page older than a cursor.
function serverPage(all, limit, cursor) {
  const c = cursor ? decodePageCursor(cursor) : null;
  const older = (m) => {
    const t = new Date(m.createdAt).getTime();
    return !c || t < c.createdAt.getTime() || (t === c.createdAt.getTime() && m.id < c.id);
  };
  const newestFirst = all.filter(older).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  return toPage(newestFirst.slice(0, limit + 1), limit);
}

test('scrolling back through 120 messages yields each exactly once, in order', () => {
  const all = thread(120);
  let page = serverPage(all, 50, null);
  let onScreen = page.messages;
  while (page.hasMore) {
    page = serverPage(all, 50, page.nextCursor);
    onScreen = prependOlderPage(onScreen, page.messages);
  }
  assert.deepEqual(ids(onScreen), ids(all));
});

test('same-millisecond messages page without loss or duplication', () => {
  const all = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, createdAt: new Date(T0).toISOString() }));
  let page = serverPage(all, 3, null);
  let onScreen = page.messages;
  while (page.hasMore) {
    page = serverPage(all, 3, page.nextCursor);
    onScreen = prependOlderPage(onScreen, page.messages);
  }
  assert.deepEqual(ids(onScreen), ids(all));
});

test('a message arriving mid-scroll does not shift the next older page', () => {
  const all = thread(120);
  const first = serverPage(all, 50, null);
  all.push(...thread(1, 120)); // a new message lands
  const second = serverPage(all, 50, first.nextCursor);
  assert.deepEqual(ids(second.messages), ids(thread(50, 20)));
});

test('merge: a refresh keeps scrolled-back pages and takes edits from the fresh page', () => {
  const all = thread(120);
  const onScreen = prependOlderPage(serverPage(all, 50, null).messages, serverPage(all, 50, encodePageCursor(all[70])).messages);
  assert.equal(onScreen.length, 100);
  const grown = [...all, ...thread(2, 120)].map((m) => (m.id === 'm00110' ? { ...m, edited: true } : m));
  const fresh = serverPage(grown, 50, null);
  const merged = mergeNewestPage(onScreen, fresh.messages, fresh.hasMore);
  assert.deepEqual(ids(merged), ids(grown.slice(20)));
  assert.equal(merged.find((m) => m.id === 'm00110').edited, true);
});

test('merge: a message deleted for me inside the fresh window disappears', () => {
  const all = thread(60);
  const onScreen = serverPage(all, 50, null).messages;
  const fresh = serverPage(all.filter((m) => m.id !== 'm00055'), 50, null);
  const merged = mergeNewestPage(onScreen, fresh.messages, fresh.hasMore);
  assert.equal(merged.some((m) => m.id === 'm00055'), false);
  assert.equal(new Set(ids(merged)).size, merged.length);
});

test('merge: no overlap (more than a page arrived) starts over instead of leaving a gap', () => {
  const all = thread(60);
  const onScreen = serverPage(all, 50, null).messages;
  const grown = [...all, ...thread(80, 60)];
  const fresh = serverPage(grown, 50, null);
  assert.deepEqual(ids(mergeNewestPage(onScreen, fresh.messages, fresh.hasMore)), ids(fresh.messages));
});

test('merge: a fresh page that is the whole thread replaces what is on screen', () => {
  const all = thread(10);
  const fresh = serverPage(all.slice(1), 50, null);
  assert.deepEqual(ids(mergeNewestPage(all, fresh.messages, fresh.hasMore)), ids(all.slice(1)));
});

test('snippet: short bodies whole, long ones windowed around the hit', () => {
  assert.equal(searchSnippet('  hello\n  world ', 'world'), 'hello world');
  const long = `${'a '.repeat(100)}the CV deadline is Friday ${'b '.repeat(100)}`;
  const s = searchSnippet(long, 'cv deadline', 60);
  assert.ok(s.includes('CV deadline'), s);
  assert.ok(s.startsWith('…') && s.endsWith('…'), s);
  assert.ok(s.length <= 62, String(s.length));
  assert.ok(searchSnippet(`${'x'.repeat(200)}`, 'nomatch', 50).endsWith('…'));
  assert.ok(searchSnippet(`${'x '.repeat(100)}end`, 'end', 40).endsWith('end'));
});

test('likeLiteral: LIKE wildcards and the escape itself become text', () => {
  assert.equal(likeLiteral('50% off'), '50\\% off');
  assert.equal(likeLiteral('snake_case'), 'snake\\_case');
  assert.equal(likeLiteral('a\\b'), 'a\\\\b');
  assert.equal(likeLiteral('plain words'), 'plain words');
});
