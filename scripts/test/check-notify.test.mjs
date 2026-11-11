import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSites, judge } from '../check-notify.mjs';

// scripts/check-notify.mjs (#1711) is a scanner, so both failure modes are pinned
// on fixture strings: missing a raw send (a feature mails past the router and the
// gate stays green) and counting one that is not there (a comment, a declaration).

const count = (src) => findSites(src).length;

test('every raw send past the router is counted', () => {
  assert.equal(count(`await sendEmail({ to, subject, html, category: 'x' });`), 1);
  assert.equal(count(`void sendPushToUser(userId, 'messages', payload);`), 1);
  assert.equal(count(`await prisma.notification.create({ data });`), 1);
  assert.equal(count(`await prisma.notification.createMany({ data: rows });`), 1);
});

test('comments, declarations and lookalikes are not sends', () => {
  assert.equal(count(`// we used to call sendEmail() here`), 0);
  assert.equal(count(`/* sendPushToUser(userId) */`), 0);
  assert.equal(count(`export async function sendEmail(opts) {}`), 0);
  assert.equal(count(`await notifyEvent(id, 'message.new', {}, { channels: ['push'] });`), 0);
  assert.equal(count(`await prisma.notificationDelivery.create({ data });`), 0);
  assert.equal(count(`const s = 'sendEmail(';`), 1, 'a string is scanned on purpose: the scanner errs towards counting');
});

test('a re-introduced raw send in an unlisted file fails; the baseline only shrinks', () => {
  const baseline = { allowed: { 'a.ts': { count: 1, reason: 'transport' } }, pending: { 'b.ts': 2 } };
  assert.deepEqual(judge({ 'a.ts': 1, 'b.ts': 2 }, baseline).problems, []);
  assert.match(judge({ 'a.ts': 1, 'b.ts': 2, 'c.ts': 1 }, baseline).problems.join('\n'), /c\.ts: 1 raw send/);
  assert.match(judge({ 'a.ts': 1, 'b.ts': 3 }, baseline).problems.join('\n'), /b\.ts: 3 raw send/);
  const lowered = judge({ 'a.ts': 1, 'b.ts': 1 }, baseline);
  assert.match(lowered.problems.join('\n'), /lower it/);
  assert.deepEqual(lowered.shrunk, { 'b.ts': 1 });
  assert.match(judge({}, { allowed: { 'a.ts': { count: 1 } } }).problems.join('\n'), /needs an integer count and a reason/);
});
