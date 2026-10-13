import * as Notifications from 'expo-notifications';
import { router, useRootNavigationState } from 'expo-router';
import { useEffect, useRef } from 'react';
import { nativeRouteFor } from '../lib/nativeRoutes';
import { openNative } from '../lib/openNative';
import { PRODUCTS } from '../lib/products';
import { tapPlan, type TapPlan } from '../lib/push';
import { registerPush, setActiveHost } from '../lib/pushDevice';
import { APP_ENV, useSession } from '../lib/session';

/**
 * Native push glue for the whole app (#2775, docs/mobile-push.md). Renders
 * nothing. Three jobs:
 *   - keep this install registered on the product it is signed in to (launch,
 *     sign-in, product switch, token change);
 *   - turn a tap — cold start included — into the screen it is about: switch
 *     product if the push belongs to the other one (without signing this one
 *     out), then nativeRouteFor(url) → openNative, else the web view;
 *   - tell the foreground handler which product is on screen.
 */
export function PushBridge() {
  const { status, product, origin, chooseProduct } = useSession();
  const host = product ? product.hosts[APP_ENV] : null;
  const navReady = Boolean(useRootNavigationState()?.key);
  const response = Notifications.useLastNotificationResponse();
  const pending = useRef<TapPlan | null>(null);
  const handled = useRef<string | null>(null);

  useEffect(() => {
    setActiveHost(status === 'signed-in' ? host : null);
  }, [status, host]);

  useEffect(() => {
    if (status !== 'signed-in' || !origin || !host) return;
    void registerPush(origin, host);
    // FCM/APNs rotated the device token: the Expo token may follow.
    const sub = Notifications.addPushTokenListener(() => void registerPush(origin, host));
    return () => sub.remove();
  }, [status, origin, host]);

  // A tap. Read only once the launch has settled which product and session the
  // app is on — deciding earlier would race the launch's own product restore.
  useEffect(() => {
    if (!response || status === 'loading') return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    const plan = tapPlan(response.notification.request.content.data, product?.id ?? null, PRODUCTS, APP_ENV);
    if (!plan) return;
    pending.current = plan;
    // Picking the other product reuses its own session (session.tsx); a
    // signed-out one shows its sign-in, and the plan waits for it.
    if (plan.switchTo) void chooseProduct(plan.switchTo);
  }, [response, status, product, chooseProduct]);

  useEffect(() => {
    const plan = pending.current;
    if (!plan || status !== 'signed-in' || !navReady) return;
    if (plan.switchTo && product?.id !== plan.switchTo) return;
    pending.current = null;
    const path = plan.path;
    if (!path) return;
    const route = nativeRouteFor(path);
    // After the protected group has mounted, not in the same commit.
    setTimeout(() => {
      if (route) openNative(route);
      else router.push({ pathname: '/web', params: { path } });
    }, 0);
  }, [status, product, navReady, response]);

  return null;
}
