/**
 * "Remember me" — trusted devices with a rotating persistent token (#1495).
 *
 * The problem: sessions are 12h JWTs (`authOptions.session.maxAge`), so anyone
 * who closes the laptop on Friday signs in again on Monday. Simply making the
 * JWT long-lived is the wrong fix — a stolen token would then be valid for
 * weeks and there is nothing to revoke, since a JWT is not stored anywhere.
 *
 * So the session stays short and a SECOND credential, stored server-side and
 * revocable, is what silently mints the next one:
 *
 *   sign in + "remember me"  →  enrolTrustedDevice()  → httpOnly cookie
 *   session expired, cookie present  →  rotateTrustedDevice()  → new session
 *
 * The safety properties live in the TrustedDevice model's comment; the code
 * below is the enforcement. In short: hashed at rest, rotated on every use,
 * theft detected by a replayed hash, idle expiry that slides and an absolute
 * expiry that does not, and revocation on every event that already revokes
 * sessions (sign-out, password change, "sign out of all devices").
 */
import { createHash, randomBytes } from 'crypto';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { clientIp, type HeaderSource } from '@/lib/clientIp';
import { REMEMBER_COOKIES } from '@/lib/rememberCookie';

/** Idle lifetime: an untouched remembered device is forgotten after 30 days. */
export const REMEMBER_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap: even a device used daily re-authenticates after 90 days. */
export const REMEMBER_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * How long the previous secret keeps working after a rotation. Two tabs waking
 * up together both send the cookie the browser had at that moment; without a
 * grace window the loser of that race would look exactly like a stolen cookie
 * and revoke the device. Short enough that a copied cookie cannot rely on it.
 */
const ROTATION_GRACE_MS = 30 * 1000;
/**
 * Most devices per account. Enrolling the 11th drops the least recently used
 * one, so the table cannot grow without bound and an old forgotten browser
 * stops being a way in.
 */
const MAX_DEVICES_PER_USER = 10;

const UA_MAX = 512;

/** The remember-me cookie on the current request, whichever spelling it uses. */
export async function readRememberToken(): Promise<string | null> {
  const store = await cookies();
  for (const name of REMEMBER_COOKIES) {
    const value = store.get(name)?.value;
    if (value) return value;
  }
  return null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  // 32 bytes of CSPRNG output — the whole security of the cookie rests here,
  // so it is never derived from anything user-controlled or guessable.
  return randomBytes(32).toString('base64url');
}

/**
 * "Chrome on Windows" from a user-agent string — enough for someone to
 * recognise their own devices in the account page, and nothing more. A
 * deliberately small table rather than a UA-parsing dependency: a wrong guess
 * costs a slightly odd label, never access.
 */
export function deviceLabel(userAgent?: string | null): string | null {
  const ua = (userAgent || '').slice(0, UA_MAX);
  if (!ua) return null;
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os;
}

export interface IssuedDevice {
  token: string;
  expiresAt: Date;
}

/** Remember this device: create the row and return the cookie value to set. */
export async function enrolTrustedDevice(userId: string, request: HeaderSource): Promise<IssuedDevice> {
  const token = newToken();
  const now = Date.now();
  const expiresAt = new Date(now + REMEMBER_IDLE_MS);
  const userAgent = (request.headers.get('user-agent') || '').slice(0, UA_MAX) || null;

  const device = await prisma.trustedDevice.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      label: deviceLabel(userAgent),
      userAgent,
      lastIp: clientIp(request),
      expiresAt,
      absoluteExpiresAt: new Date(now + REMEMBER_ABSOLUTE_MS),
    },
    select: { id: true },
  });

  await pruneDevices(userId, device.id);
  await logActivity({
    action: 'auth.device_remembered',
    actorId: userId,
    targetType: 'TrustedDevice',
    targetId: device.id,
    request,
  });

  return { token, expiresAt };
}

/** Keep only the MAX_DEVICES_PER_USER most recently used devices. */
async function pruneDevices(userId: string, keepId: string) {
  const active = await prisma.trustedDevice.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
    select: { id: true },
  });
  const surplus = active.filter((d) => d.id !== keepId).slice(MAX_DEVICES_PER_USER - 1);
  if (surplus.length === 0) return;
  await prisma.trustedDevice.updateMany({
    where: { id: { in: surplus.map((d) => d.id) } },
    data: { revokedAt: new Date() },
  });
}

export type RotateResult =
  /**
   * `token` is the replacement secret to write back — or null when another
   * request rotated this device a moment ago and its Set-Cookie is the one the
   * browser should keep. See the concurrency note in rotateTrustedDevice().
   */
  | { ok: true; userId: string; deviceId: string; token: string | null; expiresAt: Date }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reuse' };

/**
 * Verify a presented remember-me cookie and rotate it.
 *
 * On success the caller gets the user it belongs to and, usually, a fresh
 * secret to write back to the browser; minting the actual session is NOT this
 * function's job (see the `remember` provider in lib/auth.ts) so that every
 * session in the app is issued through the same NextAuth code path.
 *
 * Concurrency: two tabs waking together both present the secret the browser
 * held at that moment, and exactly one of them may rotate it. If both rotated,
 * the browser would keep whichever Set-Cookie landed last while the database
 * moved on to the other — and days later that perfectly innocent cookie would
 * look like a replayed one and revoke the device. So the rotation is a
 * conditional write, and the request that loses the race (or that arrives with
 * the just-superseded secret, inside the grace window) still gets its session
 * but returns `token: null`: leave the cookie alone, the winner already set it.
 */
export async function rotateTrustedDevice(rawToken: string, request: HeaderSource): Promise<RotateResult> {
  const presented = hashToken(rawToken);
  const now = new Date();

  const device =
    (await prisma.trustedDevice.findUnique({ where: { tokenHash: presented } })) ??
    (await prisma.trustedDevice.findUnique({ where: { prevTokenHash: presented } }));

  if (!device) return { ok: false, reason: 'unknown' };

  // Checked before the replay test below: a stale secret presented against a
  // device that was already given up (signed out, revoked from the account
  // page) is an ordinary dead cookie, and logging it as suspected theft would
  // train everyone to ignore the warning that matters.
  if (device.revokedAt) return { ok: false, reason: 'revoked' };

  // A hash we rotated away from, presented after the grace window: the browser
  // that rotated it holds the current secret, so whoever sent this one copied
  // the cookie off the machine. Burn the device — it is cheap for the real user
  // (one password prompt) and ends the thief's access.
  const isPrevious = device.tokenHash !== presented;
  const graceOpen = !!device.prevValidUntil && device.prevValidUntil > now;
  if (isPrevious && !graceOpen) {
    await prisma.trustedDevice.update({
      where: { id: device.id },
      data: { revokedAt: now, prevTokenHash: null, prevValidUntil: null },
    });
    await logActivity({
      action: 'auth.device_token_reuse',
      level: 'warning',
      actorId: device.userId,
      targetType: 'TrustedDevice',
      targetId: device.id,
      detail: 'A superseded remember-me token was replayed; the device was revoked.',
      request,
    });
    return { ok: false, reason: 'reuse' };
  }

  if (device.expiresAt <= now || device.absoluteExpiresAt <= now) return { ok: false, reason: 'expired' };

  // The account itself must still be usable. A deactivated user with a
  // remembered laptop would otherwise keep letting themselves back in.
  //
  // `sessionsValidFrom` is deliberately NOT consulted: the session this leads
  // to is minted now, so it is newer than any cutoff, and every path that
  // stamps a cutoff to lock the account down revokes the device rows too. A
  // stamp that only rotates the claims in a token (an admin changing someone's
  // role) must not cost that person their remembered laptop — the refresh reads
  // the user fresh and issues the new role.
  const user = await prisma.user.findUnique({
    where: { id: device.userId },
    select: { isActive: true },
  });
  if (!user || !user.isActive) {
    await prisma.trustedDevice.update({ where: { id: device.id }, data: { revokedAt: now } });
    return { ok: false, reason: 'revoked' };
  }

  // The idle window slides, the absolute one never does: expiresAt can only
  // move up to absoluteExpiresAt, so a daily-used device still expires.
  const slid = new Date(Math.min(now.getTime() + REMEMBER_IDLE_MS, device.absoluteExpiresAt.getTime()));
  const granted = { ok: true as const, userId: device.userId, deviceId: device.id, expiresAt: slid };

  // Arrived with the just-superseded secret while the grace window is open:
  // another request rotated a moment ago, so this one only rides along.
  if (isPrevious) {
    await prisma.trustedDevice.update({
      where: { id: device.id },
      data: { lastUsedAt: now, lastIp: clientIp(request), expiresAt: slid },
    });
    return { ...granted, token: null };
  }

  const token = newToken();
  // Conditional on the secret we verified still being the current one, so two
  // concurrent refreshes cannot both rotate.
  const { count } = await prisma.trustedDevice.updateMany({
    where: { id: device.id, tokenHash: presented },
    data: {
      tokenHash: hashToken(token),
      prevTokenHash: presented,
      prevValidUntil: new Date(now.getTime() + ROTATION_GRACE_MS),
      lastUsedAt: now,
      lastIp: clientIp(request),
      expiresAt: slid,
    },
  });

  // Lost the race: the winner's replacement cookie is the one to keep.
  return { ...granted, token: count === 1 ? token : null };
}

/** Forget the device this cookie belongs to (normal sign-out). */
export async function revokeTrustedDeviceByToken(rawToken: string): Promise<void> {
  const presented = hashToken(rawToken);
  await prisma.trustedDevice.updateMany({
    where: { OR: [{ tokenHash: presented }, { prevTokenHash: presented }], revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Forget one device by id, scoped to its owner so ids cannot be guessed at. */
export async function revokeTrustedDevice(id: string, userId: string): Promise<boolean> {
  const { count } = await prisma.trustedDevice.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count > 0;
}

/**
 * Forget every remembered device of an account.
 *
 * Called from everywhere that already invalidates sessions — password change,
 * password reset, "sign out of all devices", deactivation. Without this, a
 * remembered browser would quietly mint itself a new session moments after the
 * user locked everyone out, which is the exact opposite of what they pressed.
 */
export async function revokeAllTrustedDevices(userId: string): Promise<void> {
  await prisma.trustedDevice.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export interface TrustedDeviceView {
  id: string;
  label: string | null;
  lastIp: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

/** The account page's device list: active devices, most recently used first. */
export async function listTrustedDevices(userId: string, currentToken?: string | null): Promise<TrustedDeviceView[]> {
  const currentHash = currentToken ? hashToken(currentToken) : null;
  const devices = await prisma.trustedDevice.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
    select: {
      id: true,
      label: true,
      lastIp: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      tokenHash: true,
      prevTokenHash: true,
    },
  });
  return devices.map((d) => ({
    id: d.id,
    label: d.label,
    lastIp: d.lastIp,
    createdAt: d.createdAt.toISOString(),
    lastUsedAt: d.lastUsedAt.toISOString(),
    expiresAt: d.expiresAt.toISOString(),
    // "This device" — matched on the previous hash too, since the page may be
    // loaded in the same second a sibling tab rotated the cookie.
    current: !!currentHash && (d.tokenHash === currentHash || d.prevTokenHash === currentHash),
  }));
}

/** Revoked rows are kept this long so a replay can still be recognised. */
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Nightly housekeeping: drop device rows that can no longer authorise anything
 * and the one-minute grants left behind by every refresh.
 *
 * Revoked rows are kept for a month first — a revoked device is what a replayed
 * cookie hits, and deleting it immediately would turn a recognisable theft into
 * an anonymous "unknown token".
 */
export async function purgeExpiredTrustedDevices(): Promise<{ devices: number; grants: number }> {
  const now = new Date();
  const tombstone = new Date(now.getTime() - TOMBSTONE_MS);
  const devices = await prisma.trustedDevice.deleteMany({
    where: {
      OR: [
        { absoluteExpiresAt: { lt: tombstone } },
        { expiresAt: { lt: tombstone } },
        { revokedAt: { lt: tombstone } },
      ],
    },
  });
  const grants = await prisma.sessionRefreshGrant.deleteMany({ where: { expiresAt: { lt: now } } });
  return { devices: devices.count, grants: grants.count };
}
