// Native push (#2775, docs/mobile-push.md) — the rules, dependency-free so
// `npm test` pins them. The expo-notifications half is pushDevice.ts.
//
// A push carries `data: { url, host }` (src/lib/expoPushRules.ts on the server):
// `url` is a RELATIVE in-app path, `host` the product host the token was
// registered on. One phone has one Expo token for both products, so `host` is
// what tells a tap which product it belongs to.

import type { AppEnv, Product, ProductId } from './products';

/** The Android channel; the server sends `channelId: 'messages'`. */
export const PUSH_CHANNEL = 'messages';

export interface PushData {
  /** Same-site path, or null when the push carried none (or a bad one). */
  url: string | null;
  host: string | null;
}

const HOST_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

/**
 * The fields of a push's `data`, shape-checked: a payload is data from the
 * network, and only a same-site PATH may ever be opened from it — the in-app
 * web view only loads the product's own origin.
 */
export function pushData(raw: unknown): PushData {
  const d = (raw && typeof raw === 'object' ? raw : {}) as { url?: unknown; host?: unknown };
  const url = typeof d.url === 'string' && d.url.startsWith('/') && !d.url.startsWith('//') ? d.url : null;
  const host = typeof d.host === 'string' && HOST_RE.test(d.host) ? d.host.toLowerCase() : null;
  return { url, host };
}

/** The product a host belongs to in THIS build's environment, or null. */
export function productForHost(host: string | null, products: readonly Product[], env: AppEnv): Product | null {
  if (!host) return null;
  return products.find((p) => p.hosts[env] === host) ?? null;
}

export interface TapPlan {
  /** The product to switch to first, or null to stay where the app is. */
  switchTo: ProductId | null;
  /** What to open once signed in to that product; null opens nothing more. */
  path: string | null;
}

/**
 * What a tap on a notification does. A push from a host this build does not
 * serve (a production push reaching a preview build, a stale token) does
 * nothing beyond opening the app: guessing a product for it could open one
 * person's thread in another person's session.
 */
export function tapPlan(raw: unknown, current: ProductId | null, products: readonly Product[], env: AppEnv): TapPlan | null {
  const data = pushData(raw);
  const product = productForHost(data.host, products, env);
  if (!product) return null;
  return { switchTo: product.id === current ? null : product.id, path: data.url };
}

/**
 * Whether a push that arrives while the app is open should still show a
 * banner: not for the thread already on screen in the product it belongs to.
 * `pushThreadId` is what nativeRouteFor(data.url) found, if anything.
 */
export function shouldPresent(
  push: { host: string | null; threadId: string | null },
  screen: { host: string | null; openThreadId: string | null },
): boolean {
  if (!push.threadId || !screen.openThreadId) return true;
  return !(push.host === screen.host && push.threadId === screen.openThreadId);
}

/** AsyncStorage key holding the token last registered on a host. */
export function registrationKey(host: string): string {
  return `interncrm.push.${host}`;
}

/**
 * How the app announces its token on a host:
 *   - `register` creates (or takes over) the row — after a sign-in, on first
 *     launch of a build that has push, and when the token changed;
 *   - `refresh` only re-confirms a row the server still has. A device revoked on
 *     /account, or dropped by "sign out everywhere", therefore stays silent
 *     until the next sign-in instead of re-adding itself on every launch.
 */
export function registrationReason(stored: string | null, current: string, freshSignIn: boolean): 'register' | 'refresh' {
  return freshSignIn || stored !== current ? 'register' : 'refresh';
}

/** The ask before the system prompt is shown once per install, never again. */
export function shouldAsk(perm: { granted: boolean; canAskAgain: boolean }, askedBefore: boolean): 'granted' | 'ask' | 'skip' {
  if (perm.granted) return 'granted';
  if (!perm.canAskAgain || askedBefore) return 'skip';
  return 'ask';
}

/**
 * Whether a device-token event means the token really changed. On Android,
 * expo-notifications re-emits `onDevicePushToken` on EVERY token fetch —
 * getExpoPushTokenAsync included (PushTokenModule.kt calls onNewToken after
 * each fetch) — so a listener that re-registers on every event re-fetches,
 * which emits again: an endless loop. The first token seen is only recorded
 * (the registration that fetched it is already under way); only a DIFFERENT
 * token afterwards is a rotation worth registering.
 */
export function deviceTokenEvent(seen: string | null, incoming: string): { seen: string; register: boolean } {
  return { seen: incoming, register: seen !== null && incoming !== seen };
}
