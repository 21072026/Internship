// Unit tests for the security notices' pure half (#1717).
//
// Run: npm run test:sign-in-device  (node --test --experimental-strip-types)
//
// Two things are pinned without a database or a browser:
//   1. the new-device rule in src/lib/signInDeviceRule.ts — what a device is
//      (sha256 of the agent, capped) and when a notice is due (a CREATED row on
//      an account that already had one);
//   2. the contract between the dictionary's `securityNoticeEmail` block, the
//      notification catalogue and the e-mail groups: every notice kind has a
//      `security.<kind>` catalogue entry in the ESSENTIAL `account_security`
//      group, a subject/heading/body in all three locales, and the category the
//      sender records under resolves to that same group. A kind that drifted
//      out of the essential group would be silenced by an opt-out — the one
//      thing a security notice must never be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UA_MAX,
  SIGN_IN_DEVICE_STALE_DAYS,
  deviceFingerprint,
  newDeviceNoticeDue,
  staleSignInDeviceBefore,
} from '../../src/lib/signInDeviceRule.ts';
import { eventDef } from '../../src/lib/notifications/catalog.ts';
import { dictionaries } from '../../src/i18n/dictionaries.ts';
import { groupForCategory, isEssentialGroup } from '../../src/lib/emailGroups.ts';

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';

test('a device is the sha256 of its user-agent, capped at UA_MAX', () => {
  const a = deviceFingerprint(CHROME_MAC);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(deviceFingerprint(CHROME_MAC), a, 'the same browser is the same device');
  assert.notEqual(deviceFingerprint(FIREFOX_WIN), a, 'a different browser is a different device');
  assert.equal(deviceFingerprint(null), deviceFingerprint(''), 'no agent at all is one (anonymous) device');
  const long = 'x'.repeat(UA_MAX + 200);
  assert.equal(deviceFingerprint(long), deviceFingerprint(long.slice(0, UA_MAX)), 'bytes past the cap do not change the device');
});

test('a notice is due only for a created row on an account that already had one', () => {
  assert.equal(newDeviceNoticeDue({ created: true, priorDevices: 0 }), false, 'the first browser is the baseline');
  assert.equal(newDeviceNoticeDue({ created: true, priorDevices: 1 }), true);
  assert.equal(newDeviceNoticeDue({ created: true, priorDevices: 7 }), true);
  assert.equal(newDeviceNoticeDue({ created: false, priorDevices: 3 }), false, 'a known browser is not news');
  assert.equal(newDeviceNoticeDue({ created: false, priorDevices: -1 }), false);
});

test('a device not seen for SIGN_IN_DEVICE_STALE_DAYS is stale', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const cutoff = staleSignInDeviceBefore(now);
  assert.equal((now.getTime() - cutoff.getTime()) / 86_400_000, SIGN_IN_DEVICE_STALE_DAYS);
});

const LOCALES = ['en', 'tr', 'de'];
const kindsOf = (locale) =>
  Object.entries(dictionaries[locale].securityNoticeEmail)
    .filter(([, v]) => typeof v === 'object' && v !== null)
    .map(([k]) => k)
    .sort();

test('every notice kind has an essential catalogue entry and copy in all three locales', () => {
  const kinds = kindsOf('en');
  assert.ok(kinds.length >= 9, `expected the nine notice kinds, found ${kinds.join(', ')}`);
  for (const locale of LOCALES) {
    assert.deepEqual(kindsOf(locale), kinds, `securityNoticeEmail[${locale}] lists different kinds than en`);
    for (const kind of kinds) {
      const block = dictionaries[locale].securityNoticeEmail[kind];
      for (const field of ['subject', 'heading', 'body']) {
        assert.equal(typeof block[field], 'string', `securityNoticeEmail[${locale}].${kind}.${field} missing`);
        assert.ok(block[field].length > 0);
      }
    }
    for (const field of ['greeting', 'when', 'device', 'ip', 'unknownDevice', 'cta', 'notYou']) {
      assert.equal(typeof dictionaries[locale].securityNoticeEmail[field], 'string', `shared line ${field} missing in ${locale}`);
    }
  }
  for (const kind of kinds) {
    const def = eventDef(`security.${kind}`);
    assert.ok(def, `no catalogue entry for security.${kind}`);
    assert.equal(def.emailGroup, 'account_security', `security.${kind} left the essential group`);
    assert.equal(def.delivery, 'immediate', `security.${kind} must not wait for a digest`);
    assert.ok(def.defaultChannels.includes('inApp') && def.defaultChannels.includes('email'));
  }
});

test('the category the sender records under is the essential account_security group', () => {
  // Mirrors SECURITY_NOTICE_CATEGORY in src/lib/securityNotices.ts, which this
  // test cannot import (it reaches prisma).
  const group = groupForCategory('security');
  assert.equal(group, 'account_security');
  assert.equal(isEssentialGroup(group), true);
});

test('the e-mail copy keeps the placeholders the sender fills and no others', () => {
  const allowed = new Set(['device', 'from', 'to', 'when', 'ip', 'name']);
  for (const locale of LOCALES) {
    const M = dictionaries[locale].securityNoticeEmail;
    const strings = [];
    for (const [k, v] of Object.entries(M)) {
      if (typeof v === 'string') strings.push([k, v]);
      else for (const [f, s] of Object.entries(v)) strings.push([`${k}.${f}`, s]);
    }
    for (const [key, s] of strings) {
      for (const [, name] of s.matchAll(/\{(\w+)\}/g)) {
        assert.ok(allowed.has(name), `securityNoticeEmail[${locale}].${key} uses {${name}}, which the sender never fills`);
      }
    }
    // The in-app strings: `device` and `email` are the only declared params.
    assert.match(dictionaries[locale].notifications.events['security.newDevice'], /\{device\}/);
    assert.match(dictionaries[locale].notifications.events['security.emailChanged'], /\{email\}/);
  }
});
