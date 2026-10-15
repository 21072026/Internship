// Unit tests for the Android Digital Asset Links rule (docs/mobile-strategy.md, #2085).
//
// WHY THIS FILE EXISTS
//   Every way of getting /.well-known/assetlinks.json wrong fails SILENTLY on the
//   phone: the app opens, but as a Custom Tab with a URL bar, and nothing logs
//   why. So the rule is pinned here instead:
//     • the apps come from the server env (ANDROID_APP_LINKS, #2926), and an
//       unset value serves [] on every host — what was served before any app
//       had a fingerprint;
//     • a malformed value throws (into the server log) instead of being served;
//     • a world without a fingerprint serves [] (no association), never a
//       statement with an empty fingerprint list;
//     • a malformed fingerprint throws instead of being served;
//     • the committed Bubblewrap config carries a placeholder package, never a
//       publisher's real id — that comes from TWA_PACKAGE_ID at build time.
//
// All package names below are synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { androidAppsFromEnv, assetLinksFor, isValidFingerprint } from '../../src/lib/androidAppLinks.ts';

const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
const INTERNSHIP_PKG = 'com.example.internship';
const MARKETING_PKG = 'com.example.marketing';

test('fingerprint format: 32 upper-case hex pairs, colon-separated', () => {
  assert.equal(isValidFingerprint(FP), true);
  assert.equal(isValidFingerprint(FP.toLowerCase()), false);
  assert.equal(isValidFingerprint(FP.replace(/:/g, '')), false);
  assert.equal(isValidFingerprint(FP.slice(3)), false);
});

test('ANDROID_APP_LINKS unset or blank → no app anywhere → every host serves []', () => {
  for (const raw of [undefined, '', '   ', '\n']) {
    assert.deepEqual(androidAppsFromEnv(raw), {}, JSON.stringify(raw));
    assert.deepEqual(assetLinksFor('INTERNSHIP', androidAppsFromEnv(raw)), []);
    assert.deepEqual(assetLinksFor('MARKETING', androidAppsFromEnv(raw)), []);
  }
});

test('the route default reads the env at call time', () => {
  const before = process.env.ANDROID_APP_LINKS;
  try {
    delete process.env.ANDROID_APP_LINKS;
    assert.deepEqual(assetLinksFor('INTERNSHIP'), []);
    process.env.ANDROID_APP_LINKS = JSON.stringify({ INTERNSHIP: { packageName: INTERNSHIP_PKG, sha256CertFingerprints: [FP] } });
    assert.equal(assetLinksFor('INTERNSHIP')[0].target.package_name, INTERNSHIP_PKG);
    assert.deepEqual(assetLinksFor('MARKETING'), [], 'a vertical the env does not name has no app');
  } finally {
    if (before === undefined) delete process.env.ANDROID_APP_LINKS;
    else process.env.ANDROID_APP_LINKS = before;
  }
});

test('no fingerprint yet → no association', () => {
  const apps = androidAppsFromEnv(JSON.stringify({ INTERNSHIP: { packageName: INTERNSHIP_PKG, sha256CertFingerprints: [] } }));
  assert.deepEqual(assetLinksFor('INTERNSHIP', apps), []);
  const noList = androidAppsFromEnv(JSON.stringify({ INTERNSHIP: { packageName: INTERNSHIP_PKG } }));
  assert.deepEqual(noList.INTERNSHIP.sha256CertFingerprints, [], 'a missing list is an empty one');
  assert.deepEqual(assetLinksFor('INTERNSHIP', noList), []);
});

test('each world vouches for its own package only', () => {
  const apps = androidAppsFromEnv(
    JSON.stringify({
      INTERNSHIP: { packageName: INTERNSHIP_PKG, sha256CertFingerprints: [FP] },
      MARKETING: { packageName: MARKETING_PKG, sha256CertFingerprints: [FP] },
    })
  );
  const internship = assetLinksFor('INTERNSHIP', apps);
  assert.equal(internship.length, 1);
  assert.equal(internship[0].target.namespace, 'android_app');
  assert.equal(internship[0].target.package_name, INTERNSHIP_PKG);
  assert.deepEqual(internship[0].target.sha256_cert_fingerprints, [FP]);
  assert.ok(internship[0].relation.includes('delegate_permission/common.handle_all_urls'));
  assert.ok(internship[0].relation.includes('delegate_permission/common.get_login_creds'));
  assert.equal(assetLinksFor('MARKETING', apps)[0].target.package_name, MARKETING_PKG);
});

test('a malformed ANDROID_APP_LINKS throws instead of serving nothing in silence', () => {
  const bad = [
    ['{not json', /not valid JSON/],
    ['[]', /JSON object/],
    ['"x"', /JSON object/],
    ['null', /JSON object/],
    [JSON.stringify({ INTERNSHP: { packageName: INTERNSHIP_PKG } }), /unknown vertical: INTERNSHP/],
    [JSON.stringify({ INTERNSHIP: null }), /packageName/],
    [JSON.stringify({ INTERNSHIP: { packageName: 'nodots' } }), /packageName/],
    [JSON.stringify({ INTERNSHIP: { packageName: 'com.exa-mple.app' } }), /packageName/],
    [JSON.stringify({ INTERNSHIP: { packageName: '1com.example' } }), /packageName/],
    [JSON.stringify({ INTERNSHIP: { packageName: INTERNSHIP_PKG, sha256CertFingerprints: FP } }), /list of strings/],
    [JSON.stringify({ INTERNSHIP: { packageName: INTERNSHIP_PKG, sha256CertFingerprints: [1] } }), /list of strings/],
  ];
  for (const [raw, re] of bad) assert.throws(() => androidAppsFromEnv(raw), re, raw);
});

test('a malformed fingerprint throws instead of being served', () => {
  const apps = androidAppsFromEnv(JSON.stringify({ INTERNSHIP: { packageName: INTERNSHIP_PKG, sha256CertFingerprints: ['nope'] } }));
  assert.throws(() => assetLinksFor('INTERNSHIP', apps), /Malformed/);
});

test('the committed Bubblewrap config carries a placeholder package, not a publisher id', () => {
  const twa = JSON.parse(readFileSync(new URL('../../mobile/android/interncrm/twa-manifest.json', import.meta.url), 'utf8'));
  assert.match(twa.packageId, /^com\.example\./, 'the real package comes from TWA_PACKAGE_ID when the bundle is built');
});
