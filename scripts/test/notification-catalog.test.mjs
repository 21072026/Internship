// Unit tests for the notification event catalogue (#1710).
//
// Run: npm run test:notification-catalog  (node --test --experimental-strip-types)
//
// WHAT THIS PINS THAT NOTHING ELSE CAN
//   The catalogue and the `notifications.events` dictionary block are two halves
//   of one contract, and the type system can only see one of them. A dictionary
//   is a plain object literal: adding a key there is not a compile error
//   anywhere, and neither is deleting one. The failure mode is invisible in
//   development and rude in production — an event with no catalogue entry cannot
//   be published at all (nobody is told), and an entry with no template renders
//   as the neutral "You have a new notification." fallback for every recipient.
//
//   Worse, and the reason the placeholder assertion below exists: a template can
//   drift from its payload one locale at a time. `renderNotification()`
//   interpolates whatever `{placeholders}` its template happens to contain, so a
//   German string that gained a `{name}` the catalogue never declared renders a
//   literal "{name}" to German readers only, while EN and TR look perfect. No
//   browser test would catch that without one case per event per locale.
//
// Deliberately plain Node: both modules under test are dependency-free
// (catalog.ts has type-only imports, dictionaries.ts imports one type), so the
// contract can be asserted without a database, a browser or a bundler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_CHANNELS,
  LINK_ID_KEYS,
  eventDef,
  isNotificationEventKey,
  validateEventPayload,
} from '../../src/lib/notifications/catalog.ts';
import { dictionaries } from '../../src/i18n/dictionaries.ts';

const LOCALES = ['en', 'tr', 'de'];

// The vocabularies the catalogue must stay inside. Repeated here rather than
// imported: notificationPrefs.ts and emailGroups.ts are the sources of truth,
// but importing emailGroups.ts pulls its import-time validation into this test
// run, and the point here is the catalogue, not that file's own invariants.
const CATEGORIES = new Set([
  'messages', 'announcements', 'deadlines', 'digest', 'meetingReminders', 'mentorship',
  'documents', 'weeklyReports', 'interactions', 'goalsEvaluations', 'stageUpdates', 'newsletter',
]);
const EMAIL_GROUPS = new Set([
  'account_security', 'direct_messages', 'mentorship_lifecycle', 'pipeline_updates',
  'meeting_invites', 'meeting_reminders', 'task_reminders', 'digests', 'reports_analytics',
  'opportunities', 'inbound_requests', 'newsletter', 'announcements',
]);
const LINK_KINDS = new Set(['relation', 'thread', 'mentee', 'support', 'project', 'dashboard']);

const placeholders = (template) =>
  [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

test('every dictionary event key has a catalogue entry', () => {
  const catalogued = new Set(NOTIFICATION_EVENT_KEYS);
  for (const locale of LOCALES) {
    const keys = Object.keys(dictionaries[locale].notifications.events);
    const orphans = keys.filter((k) => !catalogued.has(k));
    assert.deepEqual(
      orphans,
      [],
      `notifications.events[${locale}] keys with no entry in src/lib/notifications/catalog.ts: ` +
        `${orphans.join(', ')}. An event with no entry cannot be published through notifyEvent().`
    );
  }
});

test('every catalogue entry has a template in all three locales', () => {
  for (const locale of LOCALES) {
    const events = dictionaries[locale].notifications.events;
    const missing = NOTIFICATION_EVENT_KEYS.filter((k) => typeof events[k] !== 'string');
    assert.deepEqual(
      missing,
      [],
      `catalogue keys with no notifications.events[${locale}] template: ${missing.join(', ')}. ` +
        'These would render as the generic fallback for every recipient in that locale.'
    );
  }
});

test('declared params match the template placeholders, in every locale', () => {
  for (const entry of NOTIFICATION_EVENTS) {
    const declared = [...entry.params].sort();
    for (const locale of LOCALES) {
      const template = dictionaries[locale].notifications.events[entry.key];
      assert.deepEqual(
        placeholders(template),
        declared,
        `${entry.key}: the ${locale} template interpolates ${JSON.stringify(placeholders(template))} ` +
          `but the catalogue declares ${JSON.stringify(declared)}. An undeclared placeholder renders ` +
          'literally; a declared one that no template uses is a payload field nobody reads.'
      );
    }
  }
});

test('a placeholder is never also a link id', () => {
  // `notifyEvent()` splits the payload in two — declared params become
  // Notification.params, LINK_ID_KEYS go to notificationLink(). A name in both
  // sets would be read by both halves, and the split would stop being a split.
  for (const entry of NOTIFICATION_EVENTS) {
    for (const p of entry.params) {
      assert.ok(
        !LINK_ID_KEYS.includes(p),
        `${entry.key}: "${p}" is both a template placeholder and a link id`
      );
    }
  }
});

test('every entry declares values from the real vocabularies', () => {
  for (const entry of NOTIFICATION_EVENTS) {
    assert.ok(CATEGORIES.has(entry.category), `${entry.key}: unknown category "${entry.category}"`);
    assert.ok(EMAIL_GROUPS.has(entry.emailGroup), `${entry.key}: unknown e-mail group "${entry.emailGroup}"`);
    assert.ok(LINK_KINDS.has(entry.link), `${entry.key}: unknown link kind "${entry.link}"`);
    assert.ok(
      entry.delivery === 'immediate' || entry.delivery === 'batched',
      `${entry.key}: delivery must be immediate|batched, got "${entry.delivery}"`
    );
    assert.ok(entry.defaultChannels.length > 0, `${entry.key}: declares no default channel`);
    for (const c of entry.defaultChannels) {
      assert.ok(NOTIFICATION_CHANNELS.includes(c), `${entry.key}: unknown channel "${c}"`);
    }
    assert.equal(
      new Set(entry.defaultChannels).size,
      entry.defaultChannels.length,
      `${entry.key}: a channel is listed twice in defaultChannels`
    );
  }
});

test('an entry that ships e-mail is never in a newsletter-only group', () => {
  // The newsletter has its own send path, its own audience and its own archive
  // (#1469). An event routed into that group would inherit an opt-out reserved
  // for content mail, so somebody who unsubscribed from career tips would stop
  // hearing about their own pipeline.
  for (const entry of NOTIFICATION_EVENTS) {
    assert.notEqual(entry.emailGroup, 'newsletter', `${entry.key}: must not use the newsletter group`);
    assert.notEqual(entry.category, 'newsletter', `${entry.key}: must not use the newsletter category`);
  }
});

test('lookups agree with the array', () => {
  assert.equal(NOTIFICATION_EVENT_KEYS.length, NOTIFICATION_EVENTS.length);
  assert.equal(new Set(NOTIFICATION_EVENT_KEYS).size, NOTIFICATION_EVENT_KEYS.length, 'duplicate key');
  for (const entry of NOTIFICATION_EVENTS) {
    assert.equal(eventDef(entry.key), entry);
    assert.ok(isNotificationEventKey(entry.key));
  }
  assert.equal(eventDef('nope.notAnEvent'), null);
  assert.equal(isNotificationEventKey('nope.notAnEvent'), false);
  assert.equal(isNotificationEventKey(undefined), false);
});

test('validateEventPayload is the runtime half of the payload type', () => {
  // The router calls this before it claims anything, because a payload rebuilt
  // from a JSON job row has no type at all.
  assert.deepEqual(validateEventPayload('deadline.stagePassed', { menteeName: 'Aylin' }), {
    ok: true,
    missing: [],
  });
  // Numbers render; the dictionary has {count} and {minutes} events.
  assert.deepEqual(validateEventPayload('project.newTodos', { count: 3 }), { ok: true, missing: [] });
  assert.deepEqual(validateEventPayload('deadline.stagePassed', {}), {
    ok: false,
    missing: ['menteeName'],
  });
  // A value interpolate() cannot substitute is as missing as no value at all —
  // it would otherwise reach the template as an undeclared object.
  assert.deepEqual(validateEventPayload('deadline.stagePassed', { menteeName: null }), {
    ok: false,
    missing: ['menteeName'],
  });
  assert.deepEqual(validateEventPayload('deadline.stagePassed', { menteeName: { a: 1 } }), {
    ok: false,
    missing: ['menteeName'],
  });
  // Not an object at all, and an unknown key: neither throws.
  assert.deepEqual(validateEventPayload('deadline.stagePassed', 'menteeName'), {
    ok: false,
    missing: ['menteeName'],
  });
  assert.deepEqual(validateEventPayload('nope.notAnEvent', {}), { ok: false, missing: [] });
  // An event with no placeholders accepts anything, including nothing.
  assert.deepEqual(validateEventPayload('evaluation.added', undefined), { ok: true, missing: [] });
});

test('a security or account event is mandatory on every channel', () => {
  // Derived from the e-mail group rather than declared per entry: an
  // `essential` group already ignores every switch on the mail side
  // (emailGroups.ts rule 1), and the router reads the same flag for the in-app
  // side. These are the events that must reach a person whatever their
  // preferences say, so the mapping is asserted rather than trusted.
  const mustBeEssential = [
    'impersonation.accessed',
    'impersonation.accessedWithReason',
    'security.passwordResetStarted',
    'security.adminSignedOutAll',
    'security.accountUnlocked',
    'role_changed.toMentor',
    'role_changed.toMentee',
    'retention.confirm',
  ];
  for (const key of mustBeEssential) {
    const entry = eventDef(key);
    assert.ok(entry, `${key} is missing from the catalogue`);
    assert.equal(
      entry.emailGroup,
      'account_security',
      `${key} must sit in the essential account_security group so no switch can silence it`
    );
  }
});
