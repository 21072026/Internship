import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY, previewLine, sendableBody, senderName, threadChanged, type InboxThread, type ThreadMessage } from './messages.ts';

const msg = (id: string, body = 'x', deleted = false): ThreadMessage => ({
  id, senderId: 's', body, createdAt: '2026-10-06T00:00:00Z', editedAt: null, deleted, attachments: [],
});

test('the composer sends trimmed, non-empty bodies within the server limit', () => {
  assert.equal(sendableBody('  hi  '), 'hi');
  assert.equal(sendableBody('   '), null);
  assert.equal(sendableBody('a'.repeat(MAX_BODY)), 'a'.repeat(MAX_BODY));
  assert.equal(sendableBody('a'.repeat(MAX_BODY + 1)), null);
});

test('inbox preview names the viewer and flattens whitespace', () => {
  const th: InboxThread = { conversationId: 'c', type: 'DIRECT', name: 'A', otherId: 'o', unread: 0, last: { body: 'a\n\nb', createdAt: '', senderId: 'me' } };
  assert.equal(previewLine(th, 'me', 'You', '—'), 'You: a b');
  assert.equal(previewLine({ ...th, last: { ...th.last!, senderId: 'o' } }, 'me', 'You', '—'), 'a b');
  assert.equal(previewLine({ ...th, last: null }, 'me', 'You', '—'), '—');
});

test('sender names only in group rooms', () => {
  const participants = [{ id: 'u1', fullName: 'Ayşe' }];
  assert.equal(senderName({ type: 'GROUP', participants }, 'u1'), 'Ayşe');
  assert.equal(senderName({ type: 'DIRECT', participants }, 'u1'), null);
});

test('an unchanged poll does not re-render; a new, edited or deleted last message does', () => {
  assert.equal(threadChanged([msg('a'), msg('b')], [msg('a'), msg('b')]), false);
  assert.equal(threadChanged([msg('a')], [msg('a'), msg('b')]), true);
  assert.equal(threadChanged([msg('a', 'x')], [msg('a', 'y')]), true);
  assert.equal(threadChanged([msg('a')], [msg('a', '', true)]), true);
});
