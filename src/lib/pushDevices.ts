/**
 * The /account list of browsers that hold a push subscription (#1716).
 *
 * The schema has promised this list since #1464 — `PushSubscription.userAgent`
 * exists with the comment "so /account can list 'Chrome on Android' rather than
 * an opaque endpoint" — but nothing ever read it, so someone who granted push on
 * three browsers could only turn push off on all of them at once.
 *
 * The one rule this module exists to enforce: **`endpoint`, `p256dh` and `auth`
 * never leave the server.** Together they are the credential for pushing to that
 * browser, and a row can be listed, labelled and revoked without any of them.
 * Every query below therefore goes through an explicit `select` allowlist rather
 * than a bare `findMany`, so adding a column to the model cannot quietly start
 * leaking it.
 *
 * Shaped after `listTrustedDevices`/`revokeTrustedDevice` in
 * `src/lib/trustedDevice.ts` on purpose — the two lists sit inches apart on
 * /account and there is no reason for them to behave differently.
 */
import { prisma } from '@/lib/prisma';
import { deviceLabel } from '@/lib/deviceLabel';

export interface PushDeviceView {
  id: string;
  /** "Chrome on Android", or null when the user-agent said nothing usable. */
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
  /** True for the row belonging to the browser making this request. */
  current: boolean;
}

/**
 * This user's subscribed browsers, newest first.
 *
 * `currentEndpoint` is the endpoint the caller's own service worker holds, which
 * the browser already knows and sends back so the row can be marked "this
 * device". It is compared here and discarded — it is never echoed, and a value
 * that matches nobody's row simply marks nothing.
 */
export async function listPushDevices(
  userId: string,
  currentEndpoint?: string | null,
): Promise<PushDeviceView[]> {
  const rows = await prisma.pushSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    // endpoint is selected only to compare against the caller's own; it is not
    // part of PushDeviceView and never reaches the response.
    select: { id: true, userAgent: true, createdAt: true, lastSeenAt: true, endpoint: true },
  });
  return rows.map((row) => ({
    id: row.id,
    // The stored user-agent is untrusted free text, so it is mapped to a fixed
    // label here and never returned raw.
    label: deviceLabel(row.userAgent),
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    current: Boolean(currentEndpoint) && row.endpoint === currentEndpoint,
  }));
}

/**
 * Revoke one subscription by id, scoped to its owner.
 *
 * Returns false when nothing was deleted — an id belonging to someone else and
 * an id that no longer exists are deliberately indistinguishable to the caller,
 * which is what makes ids safe to guess at. The route turns that into a 404.
 *
 * Deleting the row is the whole of the revocation: `sendPushToUser` reads the
 * subscription table on every send and keeps no cache of it, so a deleted row
 * stops receiving with the next notification and there is nothing to invalidate.
 */
export async function revokePushDevice(id: string, userId: string): Promise<boolean> {
  const { count } = await prisma.pushSubscription.deleteMany({ where: { id, userId } });
  return count > 0;
}
