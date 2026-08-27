import webpush, { type PushSubscription as WebPushSubscription } from 'web-push';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { notificationCategoryAllowed, type NotificationCategory } from '@/lib/notificationPrefs';

/**
 * Background Web Push (#1464, #675 Kademe 2).
 *
 * Kademe 1 shipped foreground notifications: `new Notification(...)` fired from
 * the bell's poll, which only ever works while a tab is open and focused enough
 * to keep polling. The thing actually asked for — "tell me when a message arrives
 * while I am not in the app" — needs the push service to wake the *service
 * worker*, which is what this does.
 *
 * Two hard properties:
 *   - **Optional.** With no VAPID keys configured, `pushConfigured()` is false
 *     and every send is a no-op. A deployment that never sets them behaves
 *     exactly as before; nothing here may make sending a message fail.
 *   - **Self-pruning.** A push endpoint dies silently and often (site data
 *     cleared, app uninstalled, token rotated). 404/410 is the push service
 *     telling us the endpoint is gone for good, so the row goes immediately;
 *     anything else is treated as transient until it has failed
 *     {@link MAX_FAILURES} times in a row.
 */

// Payload the service worker's `push` handler expects (see public/sw.js). Kept
// deliberately small: a push payload is capped (~4 KB) and the body is a preview,
// not the message.
export interface PushPayload {
  title: string;
  body: string;
  /** In-app path to open on click. */
  url?: string;
  /** Collapse key — a second message in the same thread replaces the first. */
  tag?: string;
}

const MAX_FAILURES = 5;
// A push service that is slow is not worth holding a request open for.
const TTL_SECONDS = 12 * 60 * 60;

let configured: boolean | null = null;

/** True when this deployment has VAPID keys, i.e. push can be delivered at all. */
export function pushConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    configured = false;
    return false;
  }
  // The subject identifies us to the push service; it must be a mailto: or https
  // URL, and web-push rejects anything else at configure time.
  const subject = process.env.VAPID_SUBJECT || `mailto:admin@${process.env.NEXTAUTH_URL?.replace(/^https?:\/\//, '') || 'localhost'}`;
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
  } catch (e) {
    logger.error('Invalid VAPID configuration — push notifications disabled', { error: String(e) });
    configured = false;
  }
  return configured;
}

/** The public key the browser needs to create a subscription. */
export function vapidPublicKey(): string | null {
  return pushConfigured() ? process.env.VAPID_PUBLIC_KEY ?? null : null;
}

/**
 * Deliver one payload to every browser this user has subscribed, honouring the
 * notification category preference. Never throws and never rejects — the caller
 * is always in the middle of something more important (writing the message).
 *
 * Returns how many endpoints accepted the push, which is what the tests assert
 * on; callers are free to ignore it.
 */
export async function sendPushToUser(
  userId: string,
  category: NotificationCategory,
  payload: PushPayload,
): Promise<number> {
  if (!pushConfigured()) return 0;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    // A category the user switched off on /account is off on every channel,
    // push included (#886).
    if (user && !notificationCategoryAllowed(user, category)) return 0;

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (subscriptions.length === 0) return 0;

    const body = JSON.stringify(payload);
    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        const target: WebPushSubscription = {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        };
        try {
          await webpush.sendNotification(target, body, { TTL: TTL_SECONDS });
          // A delivery proves the endpoint is alive; forget earlier hiccups.
          await prisma.pushSubscription
            .update({ where: { id: subscription.id }, data: { failureCount: 0, lastSeenAt: new Date() } })
            .catch(() => {});
          return true;
        } catch (e) {
          await retireOrCount(subscription.id, e);
          return false;
        }
      }),
    );
    return results.filter(Boolean).length;
  } catch (e) {
    logger.error('Push delivery failed', { userId, error: String(e) });
    return 0;
  }
}

// 404/410 is the push service saying "this endpoint no longer exists" — the one
// case where deleting immediately is correct rather than lossy.
async function retireOrCount(id: string, error: unknown) {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  if (status === 404 || status === 410) {
    await prisma.pushSubscription.delete({ where: { id } }).catch(() => {});
    return;
  }
  const row = await prisma.pushSubscription
    .update({ where: { id }, data: { failureCount: { increment: 1 } }, select: { failureCount: true } })
    .catch(() => null);
  if (row && row.failureCount >= MAX_FAILURES) {
    await prisma.pushSubscription.delete({ where: { id } }).catch(() => {});
    logger.warning('Dropped a push subscription after repeated failures', { id, status: status ?? null });
  }
}
