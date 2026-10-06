import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMore, mergePage, notificationsPath, notificationTarget, type NotificationItem } from './notifications.ts';

const n = (id: string): NotificationItem => ({ id, type: 't', display: id, link: null, read: false, createdAt: '2026-10-06T00:00:00Z' });

test('a tap only ever opens a same-site path', () => {
  assert.equal(notificationTarget('/messages/c/abc'), '/messages/c/abc');
  assert.equal(notificationTarget('https://evil.example/x'), null);
  assert.equal(notificationTarget('//evil.example/x'), null);
  assert.equal(notificationTarget(null), null);
});

test('paging', () => {
  assert.equal(notificationsPath(2), '/api/notifications?page=2&pageSize=20');
  assert.equal(notificationsPath(1, true), '/api/notifications?page=1&pageSize=20&read=unread');
  assert.equal(hasMore({ page: 1, pageSize: 20, total: 21 }), true);
  assert.equal(hasMore({ page: 2, pageSize: 20, total: 40 }), false);
});

test('merging a page appends without duplicates; a refresh replaces', () => {
  assert.deepEqual(mergePage([n('a'), n('b')], [n('b'), n('c')], false).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(mergePage([n('a')], [n('z')], true).map((x) => x.id), ['z']);
});
