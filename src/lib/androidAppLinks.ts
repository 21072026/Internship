// Digital Asset Links for the Android store apps (docs/mobile-strategy.md, #2085).
//
// The Play Store listing is a Trusted Web Activity: a thin Android shell that
// opens the live site in Chrome, full screen. Chrome only drops its URL bar when
// the SITE vouches for the APP — /.well-known/assetlinks.json on the host must
// name the app's package and the SHA-256 of the certificate it is signed with.
// Without that statement the app still works, but as a Custom Tab with a URL
// bar, which is exactly the "website in a box" look a store listing exists to
// avoid.
//
// One app per world (docs/worlds.md): the host a person opens decides the
// product, and a TWA is bound to one host, so InternshipCRM and SaleVali are two
// listings with two packages. The statement a host serves follows the host's
// vertical, never a session — the verifier fetches it without cookies.
//
// Pure and dependency-free so `npm run test:android-app-links` can pin it. The
// fingerprints live HERE, in code, not in an env var: they are public by
// definition (anyone can fetch the file), and a value that must be added to
// infra/deploy-prod.sh's env list, topic-deploy.sh's and the server's env file
// before it reaches the container is three places to forget it.

import type { VerticalKey } from '@/lib/verticals';

export interface AndroidApp {
  /**
   * The Play package name. PERMANENT: Play never lets a published package be
   * renamed, so this is the one value here that cannot be corrected later. It
   * must match `packageId` in mobile/android/<app>/twa-manifest.json.
   */
  packageName: string;
  /**
   * SHA-256 fingerprints (colon-separated, upper-case hex) of every certificate
   * an installed copy may be signed with: the Play App Signing key (Play Console
   * → App integrity) and the upload key, so an internally-shared build verifies
   * too. Empty until the first upload — the endpoint then serves `[]`, which
   * the verifier reads as "no association", i.e. today's behaviour.
   */
  sha256CertFingerprints: readonly string[];
}

// Publisher: bcsit GmbH (maintainer decision, 2026-10-05), hence the reverse
// domain of bcsit-gmbh.de. A hyphen is not legal in a Java package segment.
export const ANDROID_APPS: Record<VerticalKey, AndroidApp> = {
  INTERNSHIP: { packageName: 'de.bcsitgmbh.interncrm', sha256CertFingerprints: [] },
  MARKETING: { packageName: 'de.bcsitgmbh.salevali', sha256CertFingerprints: [] },
};

const FINGERPRINT = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;

/** A SHA-256 certificate fingerprint as keytool and Play Console print it. */
export function isValidFingerprint(value: string): boolean {
  return FINGERPRINT.test(value);
}

export interface AssetLinkStatement {
  relation: string[];
  target: { namespace: 'android_app'; package_name: string; sha256_cert_fingerprints: string[] };
}

/**
 * The assetlinks.json body for a host of the given vertical. Empty when the app
 * has no fingerprint yet. A malformed fingerprint throws rather than being
 * served: the verifier would reject the whole statement and the app would fall
 * back to a URL bar with nothing in any log saying why.
 */
export function assetLinksFor(
  vertical: VerticalKey,
  apps: Record<VerticalKey, AndroidApp> = ANDROID_APPS
): AssetLinkStatement[] {
  const app = apps[vertical];
  if (!app || app.sha256CertFingerprints.length === 0) return [];
  for (const fp of app.sha256CertFingerprints) {
    if (!isValidFingerprint(fp)) throw new Error(`Malformed SHA-256 fingerprint for ${app.packageName}: ${fp}`);
  }
  return [
    {
      // handle_all_urls is what a TWA needs; get_login_creds lets Android's
      // password manager share the site's saved credentials with the app.
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: {
        namespace: 'android_app',
        package_name: app.packageName,
        sha256_cert_fingerprints: [...app.sha256CertFingerprints],
      },
    },
  ];
}
