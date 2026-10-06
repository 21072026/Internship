import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_PATH_SOURCE, nativeRouteFor, parseOpenMessage } from './nativeRoutes.ts';

test('a conversation opens the native thread', () => {
  assert.deepEqual(nativeRouteFor('/messages/c/cmabc123'), { kind: 'thread', id: 'cmabc123' });
  assert.deepEqual(nativeRouteFor('/messages/c/cmabc123/?x=1#m'), { kind: 'thread', id: 'cmabc123' });
});

test('the inbox and the notification list open their tabs', () => {
  assert.deepEqual(nativeRouteFor('/messages'), { kind: 'tab', tab: 'messages' });
  assert.deepEqual(nativeRouteFor('/messages?tab=all'), { kind: 'tab', tab: 'messages' });
  assert.deepEqual(nativeRouteFor('/notifications'), { kind: 'tab', tab: 'notifications' });
});

test('support, the legacy relation URL and everything else stay on the web', () => {
  for (const p of ['/messages/support', '/messages/rel123', '/messages/c/a/b', '/portal', '/', '//evil/messages', 'https://x/messages', null]) {
    assert.equal(nativeRouteFor(p), null, String(p));
  }
});

test('the page-side pattern agrees with the rule', () => {
  const re = new RegExp(NATIVE_PATH_SOURCE);
  for (const p of ['/messages', '/messages/', '/messages/c/x_1-2', '/notifications', '/messages/support', '/messages/rel', '/portal', '/messages/c/a/b']) {
    assert.equal(re.test(p), nativeRouteFor(p) !== null, p);
  }
});

test('only a well-formed open message to a native path is honoured', () => {
  assert.deepEqual(parseOpenMessage('{"type":"open","path":"/messages/c/x","load":true}'), {
    route: { kind: 'thread', id: 'x' },
    load: true,
  });
  assert.equal(parseOpenMessage('{"type":"open","path":"/portal"}'), null);
  assert.equal(parseOpenMessage('{"type":"meta","title":"x"}'), null);
  assert.equal(parseOpenMessage('not json'), null);
});
