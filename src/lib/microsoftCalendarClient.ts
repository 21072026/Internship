import { prisma } from '@/lib/prisma';
import { seal, open } from '@/lib/secretBox';
import {
  MICROSOFT_CALENDAR_SCOPES,
  microsoftClientId,
  microsoftClientSecret,
  microsoftGraphApiBase,
  microsoftRedirectUri,
  microsoftTokenUrl,
} from '@/lib/microsoftCalendar';

/**
 * Talking to Microsoft Graph on ONE person's behalf (#1991), with the token
 * that person granted — the twin of src/lib/googleCalendarClient.ts.
 */

// A purpose of its own: a Microsoft token must never open with Google's key.
const PURPOSE = 'microsoft-calendar';
/** Refresh a little early, the same skew as Google. */
const REFRESH_SKEW_MS = 60_000;

export interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

const microsoftKey = (userId: string) => ({ userId_provider: { userId, provider: 'MICROSOFT' as const } });

async function tokenRequest(params: Record<string, string>): Promise<MicrosoftTokenResponse> {
  const id = microsoftClientId();
  const secret = microsoftClientSecret();
  if (!id || !secret) throw new Error('Microsoft Calendar is not configured');
  const res = await fetch(microsoftTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, scope: MICROSOFT_CALENDAR_SCOPES.join(' '), ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token request failed: ${body?.error_description || body?.error || res.status}`);
  return body as MicrosoftTokenResponse;
}

/** Exchange an authorization code for tokens. Throws with Microsoft's message. */
export async function exchangeMicrosoftCode(code: string): Promise<MicrosoftTokenResponse> {
  const redirect = microsoftRedirectUri();
  if (!redirect) throw new Error('Microsoft Calendar is not configured');
  return tokenRequest({ code, redirect_uri: redirect, grant_type: 'authorization_code' });
}

/**
 * The address the consent belongs to, from Graph's /me — shown back to the
 * person so they can tell which account this is. `mail` is empty for many
 * personal and some work accounts, so the sign-in name is the fallback.
 */
export async function microsoftAccountEmail(token: string): Promise<string | null> {
  const res = await graphFetch(token, '/me?$select=mail,userPrincipalName', { method: 'GET' }).catch(() => null);
  if (!res?.ok) return null;
  const { mail, userPrincipalName } = res.body as { mail?: unknown; userPrincipalName?: unknown };
  if (typeof mail === 'string' && mail) return mail;
  return typeof userPrincipalName === 'string' && userPrincipalName ? userPrincipalName : null;
}

export async function saveMicrosoftConnection(userId: string, tokens: MicrosoftTokenResponse, accountEmail: string) {
  const data = {
    accountEmail,
    scope: tokens.scope ?? MICROSOFT_CALENDAR_SCOPES.join(' '),
    accessTokenEnc: seal(tokens.access_token, PURPOSE),
    // Keep the stored refresh token when a re-consent returns none.
    ...(tokens.refresh_token ? { refreshTokenEnc: seal(tokens.refresh_token, PURPOSE) } : {}),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    lastError: null,
  };
  return prisma.calendarConnection.upsert({
    where: microsoftKey(userId),
    update: data,
    create: { userId, provider: 'MICROSOFT', ...data },
  });
}

/**
 * A usable access token for this user's Microsoft connection, refreshing if
 * needed — or null for every "this connection no longer works" case, recorded
 * on the row. The same contract as Google's accessTokenFor().
 */
export async function microsoftAccessTokenFor(userId: string): Promise<{ token: string; connectionId: string; calendarId: string } | null> {
  const conn = await prisma.calendarConnection.findUnique({ where: microsoftKey(userId) });
  if (!conn) return null;

  if (conn.expiresAt.getTime() - REFRESH_SKEW_MS > Date.now()) {
    const token = open(conn.accessTokenEnc, PURPOSE);
    if (token) return { token, connectionId: conn.id, calendarId: conn.calendarId };
  }
  const refreshToken = conn.refreshTokenEnc ? open(conn.refreshTokenEnc, PURPOSE) : null;
  if (!refreshToken) {
    await noteMicrosoftError(conn.id, 'No usable refresh token — the user must reconnect.');
    return null;
  }
  try {
    const tokens = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
    const updated = await prisma.calendarConnection.update({
      where: { id: conn.id },
      data: {
        accessTokenEnc: seal(tokens.access_token, PURPOSE),
        // Microsoft rotates refresh tokens: keep the new one when it sends one.
        ...(tokens.refresh_token ? { refreshTokenEnc: seal(tokens.refresh_token, PURPOSE) } : {}),
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        lastError: null,
      },
    });
    return { token: tokens.access_token, connectionId: updated.id, calendarId: updated.calendarId };
  } catch (e) {
    await noteMicrosoftError(conn.id, e instanceof Error ? e.message : 'Token refresh failed');
    return null;
  }
}

export async function noteMicrosoftError(connectionId: string, message: string) {
  await prisma.calendarConnection
    .update({ where: { id: connectionId }, data: { lastError: message.slice(0, 500) } })
    .catch(() => {});
}

export async function graphFetch(
  token: string,
  path: string,
  init: RequestInit & { method: string }
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${microsoftGraphApiBase()}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: body as Record<string, unknown> };
}

/**
 * Forget the connection. Microsoft has no token-revocation endpoint for a
 * delegated grant that an app can call on one token; the person removes the
 * app's consent at myaccount.microsoft.com (docs/microsoft-calendar.md). What
 * is ours to do is drop every copy of the tokens — the row cascades its event
 * links with it, so no orphan link survives a disconnect.
 */
export async function disconnectMicrosoft(userId: string): Promise<void> {
  await prisma.calendarConnection.deleteMany({ where: { userId, provider: 'MICROSOFT' } }).catch(() => {});
}
