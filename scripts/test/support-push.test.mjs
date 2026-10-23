import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ADMIN_SUPPORT_PATH,
  SUPPORT_PUSH_EVENTS,
  pushPreview,
  supportPushRecipients,
  supportPushTag,
} from '../../src/lib/supportPushRule.ts';
import { NOTIFICATION_EVENTS } from '../../src/lib/notifications/catalog.ts';
import { dictionaries } from '../../src/i18n/dictionaries.ts';

// Support-channel push (#3154, docs/mobile-push.md § Known gaps). The support
// line wrote bell rows only, so a support message never reached a phone with
// the app closed: the maintainer sent one from the staging APK and waited for a
// notification that could not come. These pin which events push, to whom, under
// which /account switch, and that the two routes stay wired to it.

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// Every support event in the catalogue is decided here, one way or the other.
// A new one fails the exhaustiveness test until somebody chooses.
const NOT_PUSHED = ['support.closed'];

test('every support event in the catalogue is either pushed or deliberately not', () => {
  const catalogued = NOTIFICATION_EVENTS.map((e) => e.key).filter((k) => k.startsWith('support.')).sort();
  assert.deepEqual([...SUPPORT_PUSH_EVENTS, ...NOT_PUSHED].sort(), catalogued);
  assert.ok(!SUPPORT_PUSH_EVENTS.includes('support.closed'), 'a closure is bookkeeping, not a buzz');
});

test("pushed support events sit in the catalogue's 'messages' category, the switch sendSupportPush passes", () => {
  // sendEventPush hands sendPushToUser the category 'messages'. If an event
  // moved to another category, its /account switch would silence the bell but
  // not the phone.
  for (const key of SUPPORT_PUSH_EVENTS) {
    const def = NOTIFICATION_EVENTS.find((e) => e.key === key);
    assert.ok(def, `${key} is in the catalogue`);
    assert.equal(def.category, 'messages', key);
    assert.equal(def.link, 'support', key);
  }
});

test('every pushed event has its title in all three locales', () => {
  // The push title is the bell's own template, so no new i18n key exists for
  // the tray and none can leak an internship word into the MARKETING overlay.
  for (const locale of ['en', 'tr', 'de']) {
    for (const key of SUPPORT_PUSH_EVENTS) {
      const template = dictionaries[locale].notifications.events[key];
      assert.equal(typeof template, 'string', `${locale} ${key}`);
      assert.ok(template.length > 0, `${locale} ${key}`);
    }
  }
});

test('supportPushRecipients: everyone told, once each, never the writer', () => {
  assert.deepEqual(supportPushRecipients(['a1', 'a2', 'a3'], 'mentee'), ['a1', 'a2', 'a3']);
  // An admin who opened a ticket of their own is one of the admins told about it.
  assert.deepEqual(supportPushRecipients(['a1', 'a2', 'a3'], 'a2'), ['a1', 'a3']);
  // An admin replying to their own ticket from the queue.
  assert.deepEqual(supportPushRecipients(['a1'], 'a1'), []);
  assert.deepEqual(supportPushRecipients(['a1', 'a1', 'a2'], 'x'), ['a1', 'a2']);
  assert.deepEqual(supportPushRecipients([], 'x'), []);
});

test('supportPushTag: one tray entry per ticket, never colliding with a message thread', () => {
  assert.equal(supportPushTag('t1'), 'support:t1');
  assert.notEqual(supportPushTag('t1'), supportPushTag('t2'));
  assert.ok(!supportPushTag('t1').startsWith('thread:'));
});

test('ADMIN_SUPPORT_PATH is a relative same-site path', () => {
  // PushPayload.url: the service worker and the app resolve it against the
  // recipient's own product; an origin here would be wrong for somebody.
  assert.equal(ADMIN_SUPPORT_PATH, '/admin/support');
  assert.ok(ADMIN_SUPPORT_PATH.startsWith('/') && !ADMIN_SUPPORT_PATH.startsWith('//'));
});

test('pushPreview: one line, trimmed, at most 140 characters', () => {
  assert.equal(pushPreview(undefined), '');
  assert.equal(pushPreview(null), '');
  assert.equal(pushPreview('  hello \n\n  there\t '), 'hello there');
  const exact = 'x'.repeat(140);
  assert.equal(pushPreview(exact), exact);
  const long = pushPreview('y'.repeat(141));
  assert.equal(long.length, 140);
  assert.equal(long, `${'y'.repeat(139)}…`);
});

test('the user side pushes to the admins, with the bell’s link', () => {
  const src = read('src/app/api/support/route.ts');
  assert.match(src, /supportPushRecipients\(admins\.map\(\(admin\) => admin\.id\), session\.user\.id\)/);
  assert.match(src, /sendSupportPush\(adminId, \{[^)]*link: ADMIN_SUPPORT_PATH,/);
  // The bell and the tray open the same page.
  assert.ok(!src.includes("'/admin/support'"), 'the bell uses ADMIN_SUPPORT_PATH too');
});

test('an admin reply pushes to the requester; a closure does not', () => {
  const src = read('src/app/api/admin/support/route.ts');
  const [beforePut, put] = src.split('export async function PUT');
  assert.ok(put, 'the PUT handler exists');
  assert.match(beforePut, /sendSupportPush\(requesterId, \{ type: 'support\.replied'/);
  assert.ok(!put.includes('sendSupportPush'), 'support.closed writes the bell row only');
});
