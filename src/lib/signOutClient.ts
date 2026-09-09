'use client';

import { signOut } from 'next-auth/react';

// How long the sign-out waits for the service worker to confirm it emptied its
// caches before giving up and doing the deletion from the page itself. Short on
// purpose: the worker is a local process, and a sign-out button that appears to
// hang is worse than a purge that happens one layer down.
const PURGE_ACK_TIMEOUT_MS = 1_500;

/**
 * Empty every service-worker cache for this origin (#1550).
 *
 * WHY THIS IS PART OF SIGNING OUT: the Cache API is scoped to the *browser
 * profile*, not to the account. A cache that survives a sign-out is therefore
 * readable by whoever signs in next on a shared or family device — the sharpest
 * form of the bug #1550 is about. The worker (public/sw.js v4) no longer writes
 * authenticated responses at all, but a cache written by an older worker
 * version is still sitting on the disk of every client that has visited before
 * this change, and a purge here is what removes it.
 *
 * The worker does the deletion when it is there (it also re-seeds the two public
 * precached files, so `/offline` keeps working afterwards) and we wait for its
 * ack, because `postMessage` is fire-and-forget and the redirect below would
 * otherwise race it. With no controlling worker — first visit, an unsupported
 * browser, a registration that failed — the page deletes the caches itself.
 *
 * Best-effort throughout, for the same reason the device revocation below is:
 * a sign-out must never fail because a cache could not be emptied.
 */
async function purgeServiceWorkerCaches(): Promise<void> {
  const acked = await askWorkerToPurge();
  if (acked) return;
  try {
    if (typeof caches === 'undefined') return;
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
  } catch {
    // Ignored on purpose — see above.
  }
}

async function askWorkerToPurge(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    const sw = navigator.serviceWorker;
    // `controller` is the worker that would be serving this page's requests;
    // fall back to the registration's active worker for the load where the
    // worker installed but has not claimed this client yet.
    const target = sw.controller ?? (await sw.getRegistration())?.active ?? null;
    if (!target) return false;
    return await new Promise<boolean>((resolve) => {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => {
        channel.port1.onmessage = null;
        resolve(false);
      }, PURGE_ACK_TIMEOUT_MS);
      channel.port1.onmessage = (e: MessageEvent) => {
        window.clearTimeout(timer);
        resolve((e.data as { type?: string } | null)?.type === 'PURGE_CACHE_DONE');
      };
      target.postMessage({ type: 'PURGE_CACHE' }, [channel.port2]);
    });
  } catch {
    return false;
  }
}

/**
 * Sign out of this browser — session, remembered device (#1495) AND the
 * service-worker cache (#1550).
 *
 * A plain `signOut()` only drops the session cookie. With "remember me" that is
 * not a sign-out at all: the next page load would present the device cookie and
 * be handed a new session, so the user would appear to be unable to log out.
 * Every sign-out control in the app goes through here.
 *
 * The revocation is best-effort by design: if the request fails (offline, say),
 * the sign-out still proceeds — a cookie that outlives its session is a smaller
 * problem than a sign-out button that refuses to work.
 */
export async function signOutEverywhere(callbackUrl = '/auth/signin'): Promise<void> {
  try {
    await fetch('/api/auth/remember', { method: 'DELETE' });
  } catch {
    // Ignored on purpose — see above.
  }
  // Before the redirect, not after: `signOut()` navigates, and a purge started
  // on a page that is being torn down is a purge that may not finish.
  await purgeServiceWorkerCaches();
  await signOut({ callbackUrl });
}
