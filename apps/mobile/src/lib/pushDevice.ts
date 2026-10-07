import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Alert, Platform } from 'react-native';
import { strings } from './i18n';
import { nativeRouteFor } from './nativeRoutes';
import { pushData, PUSH_CHANNEL, registrationKey, registrationReason, shouldAsk, shouldPresent } from './push';

// The expo-notifications half of native push (#2775, docs/mobile-push.md); the
// rules are in push.ts. Every function here is best-effort and never throws:
// push is an extra channel, and a phone that cannot do it (permission refused,
// no Play services, offline) simply keeps the in-app badges it already had.

const ASKED_KEY = 'interncrm.push.asked';

// What is on screen, for the foreground rule. Module state rather than React
// state: the handler below runs outside any component.
let activeHost: string | null = null;
let openThreadId: string | null = null;

export function setActiveHost(host: string | null): void {
  activeHost = host;
}

/** The thread screen reports itself while focused (null on blur). */
export function setOpenThread(id: string | null): void {
  openThreadId = id;
}

// A push arriving while the app is open: no banner for the thread already on
// screen — the thread reloads itself (thread/[id].tsx) — a banner otherwise.
Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const data = pushData(n.request.content.data);
    const route = nativeRouteFor(data.url);
    const show = shouldPresent(
      { host: data.host, threadId: route?.kind === 'thread' ? route.id : null },
      { host: activeHost, openThreadId },
    );
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
  },
});

/** Android 8+: notifications need a channel, and Android 13 shows no permission prompt before one exists. */
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(PUSH_CHANNEL, {
    name: strings().pushChannel,
    importance: Notifications.AndroidImportance.HIGH,
  }).catch(() => null);
}

/**
 * Permission, asked ONCE per install: a short native explanation first, then
 * the system prompt (POST_NOTIFICATIONS on Android 13+). A "not now" is not
 * asked again — the person can still turn it on in the phone's settings.
 */
async function permission(): Promise<boolean> {
  try {
    const perm = await Notifications.getPermissionsAsync();
    const asked = (await AsyncStorage.getItem(ASKED_KEY).catch(() => null)) === '1';
    const step = shouldAsk(perm, asked);
    if (step === 'granted') return true;
    if (step === 'skip') return false;
    await AsyncStorage.setItem(ASKED_KEY, '1').catch(() => {});
    const t = strings();
    const yes = await new Promise<boolean>((resolve) =>
      Alert.alert(t.pushAskTitle, t.pushAskBody, [
        { text: t.pushAskLater, style: 'cancel', onPress: () => resolve(false) },
        { text: t.pushAskContinue, onPress: () => resolve(true) },
      ], { cancelable: true, onDismiss: () => resolve(false) }),
    );
    if (!yes) return false;
    return (await Notifications.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

async function expoToken(): Promise<string | null> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return null;
  try {
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    // No Play services, no network, no FCM credentials in this build.
    return null;
  }
}

// Set by the session right after an explicit sign-in, consumed by the next
// registration on that host: a sign-in always (re)creates the row.
const freshSignIns = new Set<string>();

export function markFreshSignIn(host: string): void {
  freshSignIns.add(host);
}

/**
 * Register (or re-confirm) this install's token on the signed-in product's
 * host. Called whenever the app is signed in to a product: after a sign-in,
 * at launch, after switching product, and when the token changes.
 */
export async function registerPush(origin: string, host: string): Promise<void> {
  try {
    await ensureChannel();
    if (!(await permission())) return;
    const token = await expoToken();
    if (!token) return;
    const key = registrationKey(host);
    const stored = await AsyncStorage.getItem(key).catch(() => null);
    const fresh = freshSignIns.delete(host);
    const reason = registrationReason(stored, token, fresh);
    const res = await fetch(`${origin}/api/push/native`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        token,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        appVersion: Constants.expoConfig?.version,
        refresh: reason === 'refresh',
      }),
    });
    if (!res.ok) return;
    const { registered } = (await res.json()) as { registered?: boolean };
    // A refresh the server answered "no" for keeps the stored token: the next
    // launch refreshes again, and stays silent, until a sign-in registers.
    if (registered) await AsyncStorage.setItem(key, token).catch(() => {});
  } catch {
    // Best-effort.
  }
}

/**
 * Forget this install on a host — BEFORE the session ends, while the request is
 * still authorised (the order of signOutEverywhere(), src/lib/authClient.ts).
 * Only that product's row goes; the other product keeps notifying.
 */
export async function unregisterPush(origin: string, host: string): Promise<void> {
  const key = registrationKey(host);
  try {
    const token = await AsyncStorage.getItem(key);
    if (token) {
      await fetch(`${origin}/api/push/native`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token }),
      });
    }
  } catch {
    // Offline: the row stays until this product is signed in on the phone again
    // (which takes it over) or the token dies. A tap then lands on sign-in.
  }
  await AsyncStorage.removeItem(key).catch(() => {});
}
