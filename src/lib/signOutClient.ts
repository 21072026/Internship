'use client';

import { signOut } from 'next-auth/react';

/**
 * Sign out of this browser — session AND remembered device (#1495).
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
  await signOut({ callbackUrl });
}
