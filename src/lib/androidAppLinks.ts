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
// product, and a TWA is bound to one host, so the internship app and a
// marketing app are two listings with two packages. The statement a host serves
// follows the host's vertical, never a session — the verifier fetches it
// without cookies.
//
// WHERE THE APPS COME FROM: the server env, ANDROID_APP_LINKS (#2926) — a JSON
// object keyed by vertical:
//
//   ANDROID_APP_LINKS='{"INTERNSHIP":{"packageName":"com.example.crm","sha256CertFingerprints":["AB:CD:…"]}}'
//
// A package name and a signing certificate belong to whoever PUBLISHES the app,
// i.e. to the deployment: this project is AGPL, and a package id written into
// the source would make every other instance vouch for the original publisher's
// app. The values themselves are public by definition (anyone can fetch the
// file), so the env file is the right home, not a secret store. Unset or empty
// means no app is associated with any host, and every host serves `[]` — what
// every host served while no fingerprint existed.
//
// Pure and dependency-free so `npm run test:android-app-links` can pin it.

import type { VerticalKey } from '@/lib/verticals';

export interface AndroidApp {
  /**
   * The Play package name. PERMANENT: Play never lets a published package be
   * renamed, so this is the one value here that cannot be corrected later. It
   * must match the `packageId` the app was built with
   * (mobile/android/generate-project.mjs, TWA_PACKAGE_ID).
   */
  packageName: string;
  /**
   * SHA-256 fingerprints (colon-separated, upper-case hex) of every certificate
   * an installed copy may be signed with: the Play App Signing key (Play Console
   * → App integrity) and the upload key, so an internally-shared build verifies
   * too. Empty until the first upload — the endpoint then serves `[]`, which
   * the verifier reads as "no association".
   */
  sha256CertFingerprints: readonly string[];
}

export type AndroidApps = Partial<Record<VerticalKey, AndroidApp>>;

// Every vertical, so a key in ANDROID_APP_LINKS that names no vertical (a typo
// that would otherwise serve `[]` in silence) is refused. A Record, so adding a
// vertical to src/lib/verticals.ts fails the type check until it is listed here.
const VERTICAL_KEYS: Record<VerticalKey, true> = { INTERNSHIP: true, MARKETING: true };

// A Java package name: two or more dot-separated identifiers. A hyphen is not
// legal in a segment, which is why a reverse domain with one loses it.
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

const FINGERPRINT = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;

/** A SHA-256 certificate fingerprint as keytool and Play Console print it. */
export function isValidFingerprint(value: string): boolean {
  return FINGERPRINT.test(value);
}

/**
 * The apps ANDROID_APP_LINKS configures, by vertical. Unset, empty or
 * whitespace-only is "no app anywhere". Anything malformed THROWS — invalid
 * JSON, an unknown vertical, a bad package name, a fingerprint list that is not
 * a list of strings — for the same reason assetLinksFor() throws on a bad
 * fingerprint: a statement the verifier rejects fails silently on the phone,
 * while a 500 on /.well-known/assetlinks.json is in the server log.
 */
export function androidAppsFromEnv(raw: string | undefined = process.env.ANDROID_APP_LINKS): AndroidApps {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ANDROID_APP_LINKS is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ANDROID_APP_LINKS must be a JSON object keyed by vertical');
  }
  const out: AndroidApps = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(VERTICAL_KEYS, key)) {
      throw new Error(`ANDROID_APP_LINKS names an unknown vertical: ${key}`);
    }
    const app = value as { packageName?: unknown; sha256CertFingerprints?: unknown } | null;
    if (!app || typeof app !== 'object' || typeof app.packageName !== 'string' || !PACKAGE_NAME.test(app.packageName)) {
      throw new Error(`ANDROID_APP_LINKS.${key}.packageName must be a Java package name`);
    }
    const fps = app.sha256CertFingerprints ?? [];
    if (!Array.isArray(fps) || fps.some((fp) => typeof fp !== 'string')) {
      throw new Error(`ANDROID_APP_LINKS.${key}.sha256CertFingerprints must be a list of strings`);
    }
    out[key as VerticalKey] = { packageName: app.packageName, sha256CertFingerprints: fps as string[] };
  }
  return out;
}

export interface AssetLinkStatement {
  relation: string[];
  target: { namespace: 'android_app'; package_name: string; sha256_cert_fingerprints: string[] };
}

/**
 * The assetlinks.json body for a host of the given vertical. Empty when that
 * vertical has no app, or its app has no fingerprint yet. A malformed
 * fingerprint throws rather than being served: the verifier would reject the
 * whole statement and the app would fall back to a URL bar with nothing in any
 * log saying why.
 */
export function assetLinksFor(vertical: VerticalKey, apps: AndroidApps = androidAppsFromEnv()): AssetLinkStatement[] {
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
