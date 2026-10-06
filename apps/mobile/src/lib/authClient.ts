// The networked half of the app's sign-in (#2775); the rules live in
// authProtocol.ts. Every call goes to ONE origin — the chosen product's host —
// and relies on the OS cookie jar: React Native's fetch stores Set-Cookie there,
// and the in-app web view reads the same jar (Android: always; iOS:
// `sharedCookiesEnabled`), so a web screen opens already signed in.
//
// Native fetch sends no Origin header, which the server's cross-site write gate
// (src/lib/writeOrigin.ts) treats as a non-browser client — the same as curl.

import {
  callbackBody,
  classifySignInError,
  errorFromCallbackUrl,
  sessionUserFrom,
  type SessionUser,
  type SignInErrorCode,
} from './authProtocol';

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function csrfToken(origin: string): Promise<string> {
  const res = await fetch(`${origin}/api/auth/csrf`, { credentials: 'include' });
  const body = (await res.json()) as { csrfToken?: string };
  if (!body.csrfToken) throw new Error('csrf');
  return body.csrfToken;
}

/** POST /api/auth/callback/<provider>, the way next-auth/react's signIn() does. */
async function callback(origin: string, provider: string, fields: Record<string, string>): Promise<string | null> {
  const token = await csrfToken(origin);
  const res = await fetch(`${origin}/api/auth/callback/${provider}`, {
    method: 'POST',
    headers: FORM,
    credentials: 'include',
    body: callbackBody(fields, token, `${origin}/`),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: unknown };
  return errorFromCallbackUrl(body.url);
}

export async function getSession(origin: string): Promise<SessionUser | null> {
  try {
    const res = await fetch(`${origin}/api/auth/session`, { credentials: 'include' });
    if (!res.ok) return null;
    return sessionUserFrom(await res.json());
  } catch {
    return null;
  }
}

export type SignInResult = { ok: true; user: SessionUser } | { ok: false; error: SignInErrorCode | 'NETWORK' };

export async function signInWithPassword(
  origin: string,
  input: { email: string; password: string; totp?: string; remember: boolean },
): Promise<SignInResult> {
  try {
    const error = await callback(origin, 'credentials', {
      email: input.email,
      password: input.password,
      totp: input.totp ?? '',
    });
    if (error) return { ok: false, error: classifySignInError(error) };
    const user = await getSession(origin);
    if (!user) return { ok: false, error: 'INVALID' };
    // Same order as the web sign-in page: a provider cannot set the remember-me
    // cookie, so the device is enrolled by a separate call that the session the
    // password (and TOTP) just earned authorises (docs/remember-me.md).
    if (input.remember) {
      await fetch(`${origin}/api/auth/remember`, { method: 'POST', credentials: 'include' }).catch(() => {});
    }
    return { ok: true, user };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

/**
 * Re-open a session from the remembered device, as /auth/resume does: trade the
 * remember-me cookie for a single-use grant, then the grant for a session
 * through the `remember` provider. Null when there is nothing to resume.
 */
export async function resumeSession(origin: string): Promise<SessionUser | null> {
  try {
    const res = await fetch(`${origin}/api/auth/remember/refresh`, { method: 'POST', credentials: 'include' });
    if (res.status !== 200) return null;
    const { grant } = (await res.json()) as { grant?: string };
    if (!grant) return null;
    const error = await callback(origin, 'remember', { grant });
    if (error) return null;
    return await getSession(origin);
  } catch {
    return null;
  }
}

/**
 * Sign out the way signOutEverywhere() does (src/lib/signOutClient.ts): revoke
 * the remembered device FIRST, or the next launch would sign straight back in,
 * then end the session. Best-effort — a sign-out never refuses to happen.
 */
export async function signOut(origin: string): Promise<void> {
  await fetch(`${origin}/api/auth/remember`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
  try {
    const token = await csrfToken(origin);
    await fetch(`${origin}/api/auth/signout`, {
      method: 'POST',
      headers: FORM,
      credentials: 'include',
      body: callbackBody({}, token, `${origin}/`),
    });
  } catch {
    // Offline: the session cookie expires on its own (12h) and the device is revoked.
  }
}
