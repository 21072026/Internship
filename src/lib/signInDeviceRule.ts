/**
 * The "new sign-in device" rule (#1717) — pure, dependency-free apart from the
 * hash, so a unit test can pin it without a database.
 *
 * WHAT A DEVICE IS. The SHA-256 of the user-agent string. Two tabs of one
 * browser are one device; a browser upgrade is a new one. Deliberately coarse:
 * a fingerprint that tried harder (canvas, fonts, screen) would be a tracking
 * technique, and the point here is a notice the account owner recognises
 * ("Chrome on macOS"), not identification. Erring towards one extra notice per
 * browser upgrade is the cheaper mistake; a notice that never fires is the one
 * that costs an account.
 *
 * WHEN THE NOTICE IS DUE. Only when the sign-in CREATED a device row AND the
 * account already had at least one: the first browser ever seen is the baseline
 * and has nothing to be compared against. This also makes the rollout silent —
 * every existing account's next sign-in writes its baseline and mails nobody.
 */
import { createHash } from 'node:crypto';

/** Longest user-agent kept, matching the TrustedDevice column discipline. */
export const UA_MAX = 512;

/** Devices remembered per account; the oldest by last use is dropped past this. */
export const SIGN_IN_DEVICE_KEEP = 20;

/** A device not seen for this long is forgotten — its next sign-in is "new" again. */
export const SIGN_IN_DEVICE_STALE_DAYS = 180;

export function normalizeUserAgent(userAgent?: string | null): string {
  return (userAgent || '').slice(0, UA_MAX);
}

/** sha256(userAgent), hex — the row key. An absent agent is one (anonymous) device. */
export function deviceFingerprint(userAgent?: string | null): string {
  return createHash('sha256').update(normalizeUserAgent(userAgent)).digest('hex');
}

export interface SignInDeviceObservation {
  /** The sign-in created the device row (the browser was not on file). */
  created: boolean;
  /** Devices the account had BEFORE this sign-in. */
  priorDevices: number;
}

/** Whether the observation earns a "new sign-in device" notice. */
export function newDeviceNoticeDue(o: SignInDeviceObservation): boolean {
  return o.created && o.priorDevices > 0;
}

/** The cut-off before which a device row is stale. */
export function staleSignInDeviceBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - SIGN_IN_DEVICE_STALE_DAYS * 24 * 60 * 60 * 1000);
}
