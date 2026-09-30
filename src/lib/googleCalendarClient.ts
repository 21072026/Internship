import { prisma } from '@/lib/prisma';
import { seal, open } from '@/lib/secretBox';
import {
  googleCalendarApiBase,
  googleClientId,
  googleRedirectUri,
  googleRevokeUrl,
  googleTokenUrl,
} from '@/lib/googleCalendar';

/**
 * Talking to Google on a user's behalf (#709).
 *
 * Everything here is scoped to ONE person's own calendar, using the token that
 * person granted. There is no service account and no app-owned calendar: the
 * app can only ever write where someone has explicitly let it.
 */

const PURPOSE = 'google-calendar';
/** Refresh a little early, so a token doesn't expire mid-request. */
const REFRESH_SKEW_MS = 60_000;

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
}

function clientSecret(): string | null {
  return process.env.GOOGLE_CLIENT_SECRET || null;
}

/** Exchange an authorization code for tokens. Throws with Google's message. */
export async function exchangeCode(code: string): Promise<TokenResponse> {
  const id = googleClientId();
  const secret = clientSecret();
  const redirect = googleRedirectUri();
  if (!id || !secret || !redirect) throw new Error('Google Calendar is not configured');

  const res = await fetch(googleTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token exchange failed: ${body?.error_description || body?.error || res.status}`);
  return body as TokenResponse;
}

async function refresh(refreshToken: string): Promise<TokenResponse> {
  const id = googleClientId();
  const secret = clientSecret();
  if (!id || !secret) throw new Error('Google Calendar is not configured');
  const res = await fetch(googleTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: id, client_secret: secret, grant_type: 'refresh_token' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token refresh failed: ${body?.error_description || body?.error || res.status}`);
  return body as TokenResponse;
}

/** The e-mail Google says the consent belongs to, read out of the id_token. */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  // The id_token arrives over TLS straight from the token endpoint we called,
  // so its payload is trustworthy for a display label. It is NOT used to
  // authenticate anyone — the session already did that — which is why decoding
  // without signature verification is acceptable here and nowhere else.
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof json.email === 'string' ? json.email : null;
  } catch {
    return null;
  }
}

export async function saveConnection(userId: string, tokens: TokenResponse, googleEmail: string) {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const data = {
    googleEmail,
    scope: tokens.scope ?? '',
    accessTokenEnc: seal(tokens.access_token, PURPOSE),
    // Google only returns a refresh token on the FIRST consent. Re-consenting
    // without one must not wipe the one we have, or the connection silently
    // becomes read-once and dies at the next expiry.
    ...(tokens.refresh_token ? { refreshTokenEnc: seal(tokens.refresh_token, PURPOSE) } : {}),
    expiresAt,
    lastError: null,
  };
  return prisma.googleCalendarConnection.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

/**
 * A usable access token for this user, refreshing if needed — or null.
 *
 * Null covers every "this connection no longer works" case: no connection, a
 * token that will not decrypt (secret rotated, row copied between environments),
 * no refresh token, or Google refusing the refresh. The caller's answer is
 * always the same — skip the push and let the person reconnect — so they are
 * one return value, not four exceptions.
 */
export async function accessTokenFor(userId: string): Promise<{ token: string; connectionId: string; calendarId: string } | null> {
  const conn = await prisma.googleCalendarConnection.findUnique({ where: { userId } });
  if (!conn) return null;

  if (conn.expiresAt.getTime() - REFRESH_SKEW_MS > Date.now()) {
    const token = open(conn.accessTokenEnc, PURPOSE);
    if (token) return { token, connectionId: conn.id, calendarId: conn.calendarId };
  }

  const refreshToken = conn.refreshTokenEnc ? open(conn.refreshTokenEnc, PURPOSE) : null;
  if (!refreshToken) {
    await noteError(conn.id, 'No usable refresh token — the user must reconnect.');
    return null;
  }
  try {
    const tokens = await refresh(refreshToken);
    const updated = await prisma.googleCalendarConnection.update({
      where: { id: conn.id },
      data: {
        accessTokenEnc: seal(tokens.access_token, PURPOSE),
        ...(tokens.refresh_token ? { refreshTokenEnc: seal(tokens.refresh_token, PURPOSE) } : {}),
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        lastError: null,
      },
    });
    return { token: tokens.access_token, connectionId: updated.id, calendarId: updated.calendarId };
  } catch (e) {
    await noteError(conn.id, e instanceof Error ? e.message : 'Token refresh failed');
    return null;
  }
}

export async function noteError(connectionId: string, message: string) {
  await prisma.googleCalendarConnection
    .update({ where: { id: connectionId }, data: { lastError: message.slice(0, 500) } })
    .catch(() => {});
}

export async function calendarFetch(
  token: string,
  path: string,
  init: RequestInit & { method: string }
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${googleCalendarApiBase()}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: body as Record<string, unknown> };
}

/** Revoke at Google, then forget locally. Local deletion happens either way. */
export async function disconnect(userId: string): Promise<void> {
  const conn = await prisma.googleCalendarConnection.findUnique({ where: { userId } });
  if (!conn) return;
  const token = (conn.refreshTokenEnc ? open(conn.refreshTokenEnc, PURPOSE) : null) ?? open(conn.accessTokenEnc, PURPOSE);
  if (token) {
    // Best effort: if Google is unreachable we still drop our copy. Keeping a
    // token the person asked us to forget would be the worse failure.
    await fetch(googleRevokeUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => {});
  }
  await prisma.googleCalendarConnection.delete({ where: { id: conn.id } }).catch(() => {});
}
