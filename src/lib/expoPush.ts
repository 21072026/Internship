import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import {
  MAX_FAILURES,
  readReceipts,
  sendBatches,
  type NativePushPayload,
} from '@/lib/expoPushRules';

/**
 * Native push (#2775, docs/mobile-push.md): the Prisma-aware half. The rules —
 * batching, ticket and receipt classification — live in `expoPushRules.ts`.
 *
 * Mirrors webPush.ts on the two properties that matter:
 *   - **Never throws.** The caller is writing a message; a push service that is
 *     down must not be able to fail it.
 *   - **Self-pruning.** `DeviceNotRegistered` (the app was uninstalled, or the
 *     token rotated) deletes the row at once; any other error counts towards
 *     MAX_FAILURES, and a receipt that reads `ok` resets the count.
 *
 * Unlike web push there is nothing to configure: the Expo push service needs no
 * key to accept a message. `EXPO_ACCESS_TOKEN` is optional — set it only after
 * turning on "enhanced push security" for the Expo project, which then rejects
 * any send without it.
 */

// Expo's advice: read receipts about 15 minutes after the send; they are kept
// for 24 hours. In-process and best-effort on purpose: a restart in between
// loses one check, and the next send to a dead token produces a new receipt.
const RECEIPT_DELAY_MS = 15 * 60 * 1000;

function accessToken(): string | null {
  return process.env.EXPO_ACCESS_TOKEN || null;
}

/** Deliver one payload to every app install of this user. Returns how many Expo accepted. */
export async function sendNativePushToUser(userId: string, payload: NativePushPayload): Promise<number> {
  try {
    const targets = await prisma.nativePushToken.findMany({
      where: { userId },
      select: { id: true, token: true, host: true },
    });
    if (targets.length === 0) return 0;

    const outcome = await sendBatches(targets, payload, { fetch, accessToken: accessToken() });
    await retire(outcome.gone);
    await countFailures(outcome.failed);
    if (outcome.delivered.length > 0) {
      setTimeout(() => void checkReceipts(outcome.delivered), RECEIPT_DELAY_MS).unref?.();
    }
    return outcome.delivered.length;
  } catch (e) {
    logger.error('Native push delivery failed', { userId, error: String(e) });
    return 0;
  }
}

async function checkReceipts(tickets: { rowId: string; ticketId: string }[]): Promise<void> {
  try {
    const r = await readReceipts(tickets, { fetch, accessToken: accessToken() });
    await retire(r.gone);
    await countFailures(r.failed);
    if (r.ok.length > 0) {
      await prisma.nativePushToken
        .updateMany({ where: { id: { in: r.ok } }, data: { failureCount: 0 } })
        .catch(() => {});
    }
  } catch (e) {
    logger.error('Native push receipt check failed', { error: String(e) });
  }
}

async function retire(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.nativePushToken.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

async function countFailures(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.nativePushToken
    .updateMany({ where: { id: { in: ids } }, data: { failureCount: { increment: 1 } } })
    .catch(() => {});
  const { count } = await prisma.nativePushToken
    .deleteMany({ where: { id: { in: ids }, failureCount: { gte: MAX_FAILURES } } })
    .catch(() => ({ count: 0 }));
  if (count > 0) logger.warning('Dropped native push tokens after repeated failures', { count });
}

/**
 * Forget every app install of these accounts. Called next to
 * `revokeAllTrustedDevices` (src/lib/trustedDevice.ts): when sessions are
 * revoked, the phones are signed out, and a signed-out phone must stop showing
 * that account's messages on its lock screen.
 */
export async function revokeNativePushTokens(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await prisma.nativePushToken.deleteMany({ where: { userId: { in: userIds } } });
}
