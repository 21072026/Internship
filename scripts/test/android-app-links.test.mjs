// Unit tests for the Android Digital Asset Links rule (docs/mobile-strategy.md, #2085).
//
// WHY THIS FILE EXISTS
//   Every way of getting /.well-known/assetlinks.json wrong fails SILENTLY on the
//   phone: the app opens, but as a Custom Tab with a URL bar, and nothing logs
//   why. So the rule is pinned here instead:
//     • the package names are permanent once published, and must equal the
//       `packageId` in each mobile/android/<app>/twa-manifest.json — two copies
//       that are only allowed to exist because this test compares them;
//     • a world without a fingerprint serves [] (no association), never a
//       statement with an empty fingerprint list;
//     • a malformed fingerprint throws instead of being served.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANDROID_APPS, assetLinksFor, isValidFingerprint } from '../../src/lib/androidAppLinks.ts';

const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');

test('fingerprint format: 32 upper-case hex pairs, colon-separated', () => {
  assert.equal(isValidFingerprint(FP), true);
  assert.equal(isValidFingerprint(FP.toLowerCase()), false);
  assert.equal(isValidFingerprint(FP.replace(/:/g, '')), false);
  assert.equal(isValidFingerprint(FP.slice(3)), false);
});

test('no fingerprint yet → no association', () => {
  assert.deepEqual(assetLinksFor('INTERNSHIP', { ...ANDROID_APPS }), []);
});

test('each world vouches for its own package only', () => {
  const apps = {
    INTERNSHIP: { packageName: 'de.bcsitgmbh.interncrm', sha256CertFingerprints: [FP] },
    MARKETING: { packageName: 'de.bcsitgmbh.salevali', sha256CertFingerprints: [FP] },
  };
  const internship = assetLinksFor('INTERNSHIP', apps);
  assert.equal(internship.length, 1);
  assert.equal(internship[0].target.package_name, 'de.bcsitgmbh.interncrm');
  assert.deepEqual(internship[0].target.sha256_cert_fingerprints, [FP]);
  assert.ok(internship[0].relation.includes('delegate_permission/common.handle_all_urls'));
  assert.equal(assetLinksFor('MARKETING', apps)[0].target.package_name, 'de.bcsitgmbh.salevali');
});

test('a malformed fingerprint throws instead of being served', () => {
  const apps = { ...ANDROID_APPS, INTERNSHIP: { packageName: 'x.y', sha256CertFingerprints: ['nope'] } };
  assert.throws(() => assetLinksFor('INTERNSHIP', apps), /Malformed/);
});

test('every fingerprint committed today is well-formed', () => {
  for (const app of Object.values(ANDROID_APPS)) {
    for (const fp of app.sha256CertFingerprints) assert.ok(isValidFingerprint(fp), `${app.packageName}: ${fp}`);
  }
});

test('package names match the Bubblewrap configs', () => {
  const dirs = { INTERNSHIP: 'interncrm', MARKETING: 'salevali' };
  for (const [vertical, dir] of Object.entries(dirs)) {
    const twa = JSON.parse(readFileSync(new URL(`../../mobile/android/${dir}/twa-manifest.json`, import.meta.url), 'utf8'));
    assert.equal(twa.packageId, ANDROID_APPS[vertical].packageName, `${dir}/twa-manifest.json packageId`);
  }
});
