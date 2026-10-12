/**
 * The account's memory of the browsers it has signed in from (#1717) — the
 * Prisma half of src/lib/signInDeviceRule.ts. One row per (user, fingerprint),
 * read only through the user it belongs to; the security notice that reads the
 * answer lives in src/lib/securityNotices.ts.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { clientIp, type HeaderSource } from '@/lib/clientIp';
import { deviceLabel } from '@/lib/deviceLabel';
import {
  deviceFingerprint,
  normalizeUserAgent,
  SIGN_IN_DEVICE_KEEP,
  staleSignInDeviceBefore,
  type SignInDeviceObservation,
} from '@/lib/signInDeviceRule';

export interface NotedSignInDevice extends SignInDeviceObservation {
  /** "Chrome on macOS", or null when the agent is not one the allowlist knows. */
  label: string | null;
  /** The address the sign-in came from, as far as the proxy chain can be trusted. */
  ip: string;
}

/**
 * Record that `userId` just signed in from `request`'s browser and say whether
 * that browser was new to the account. Two queries on the common path (lookup,
 * touch); a create on a new browser. A concurrent first sign-in from the same
 * browser loses the unique race and is reported as "not created", so two tabs
 * cannot earn two notices.
 */
export async function noteSignInDevice(userId: string, request: HeaderSource): Promise<NotedSignInDevice> {
  const userAgent = normalizeUserAgent(request.headers.get('user-agent')) || null;
  const fingerprint = deviceFingerprint(userAgent);
  const label = deviceLabel(userAgent);
  const ip = clientIp(request);
  const now = new Date();

  const existing = await prisma.signInDevice.findUnique({
    where: { userId_fingerprint: { userId, fingerprint } },
    select: { id: true },
  });
  if (existing) {
    await prisma.signInDevice.update({
      where: { id: existing.id },
      data: { lastSeenAt: now, lastIp: ip, label },
    });
    return { created: false, priorDevices: -1, label, ip };
  }

  const priorDevices = await prisma.signInDevice.count({ where: { userId } });
  try {
    await prisma.signInDevice.create({
      data: { userId, fingerprint, label, userAgent, lastIp: ip, firstSeenAt: now, lastSeenAt: now },
      select: { id: true },
    });
  } catch (e) {
    // P2002: the other tab got there first — the browser is on file now.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { created: false, priorDevices, label, ip };
    }
    throw e;
  }
  await pruneSignInDevices(userId);
  return { created: true, priorDevices, label, ip };
}

/** Keep the account's list bounded: the oldest by last use go past SIGN_IN_DEVICE_KEEP. */
async function pruneSignInDevices(userId: string): Promise<void> {
  const surplus = await prisma.signInDevice.findMany({
    where: { userId },
    orderBy: { lastSeenAt: 'desc' },
    skip: SIGN_IN_DEVICE_KEEP,
    select: { id: true },
  });
  if (surplus.length) {
    await prisma.signInDevice.deleteMany({ where: { id: { in: surplus.map((d) => d.id) } } });
  }
}

/** Nightly: forget devices not seen for SIGN_IN_DEVICE_STALE_DAYS. Returns the count. */
export async function purgeStaleSignInDevices(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.signInDevice.deleteMany({ where: { lastSeenAt: { lt: staleSignInDeviceBefore(now) } } });
  return count;
}
