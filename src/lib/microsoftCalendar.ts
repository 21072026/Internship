// Microsoft 365 / Outlook calendar config & gating (#1991) — the second
// calendar provider, built on the same shape as src/lib/googleCalendar.ts.
//
// DELEGATED permissions only (offline_access User.Read Calendars.ReadWrite):
// the app writes exclusively to the calendar of a person who consented, never
// with application permissions across a tenant — the promise in
// src/lib/googleCalendarSync.ts holds for both providers.
//
// No secrets are hard-coded; everything reads from env. Microsoft's endpoints
// are env-overridable with the real URLs as defaults, exactly like Google's,
// because that is what lets e2e drive connect → callback → push → disconnect
// against a local stub (e2e/support/microsoft-mock.mjs) with no real tenant.
//
// Operator env (docs/microsoft-calendar.md):
//   MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET  the app registration
//   MICROSOFT_TENANT                               default `common` (work + personal)
//   MICROSOFT_OAUTH_REDIRECT_URI                   optional pin of the registered callback
//   MICROSOFT_CALENDAR_ENABLED=1                   the master switch, default OFF

export const MICROSOFT_CALENDAR_SCOPES = ['offline_access', 'User.Read', 'Calendars.ReadWrite'];

export function microsoftClientId(): string | null {
  return process.env.MICROSOFT_CLIENT_ID || null;
}

export function microsoftClientSecret(): string | null {
  return process.env.MICROSOFT_CLIENT_SECRET || null;
}

function tenant(): string {
  return process.env.MICROSOFT_TENANT || 'common';
}

/**
 * Where Microsoft sends the browser back to — an IdP-registered endpoint, so
 * it is the configured origin (or an explicit pin), never the request host. A
 * flow started on another served host is handed back there by the callback,
 * through the signed state, exactly as Google's is (#2494).
 */
export function microsoftRedirectUri(): string | null {
  if (process.env.MICROSOFT_OAUTH_REDIRECT_URI) return process.env.MICROSOFT_OAUTH_REDIRECT_URI;
  const base = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL;
  return base ? `${base.replace(/\/$/, '')}/api/integrations/microsoft/callback` : null;
}

export function microsoftAuthorizeUrl(): string {
  return process.env.MICROSOFT_OAUTH_AUTHORIZE_URL || `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`;
}

export function microsoftTokenUrl(): string {
  return process.env.MICROSOFT_OAUTH_TOKEN_URL || `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`;
}

export function microsoftGraphApiBase(): string {
  return (process.env.MICROSOFT_GRAPH_API_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
}

export function isMicrosoftCalendarConfigured(): boolean {
  return !!(microsoftClientId() && microsoftClientSecret() && microsoftRedirectUri());
}

/** The consent URL (pure). `state` is the signed anti-replay token. */
export function microsoftConsentUrl(state: string): string | null {
  const clientId = microsoftClientId();
  const redirectUri = microsoftRedirectUri();
  if (!clientId || !redirectUri) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: MICROSOFT_CALENDAR_SCOPES.join(' '),
    // Always show the account picker, so a person with a work and a personal
    // account chooses which calendar this is.
    prompt: 'select_account',
    state,
  });
  return `${microsoftAuthorizeUrl()}?${params.toString()}`;
}

/**
 * The master switch, default OFF — credentials appearing in the env must not
 * switch the integration on by themselves (the same rule as Google's).
 */
export function isMicrosoftCalendarEnabled(): boolean {
  return process.env.MICROSOFT_CALENDAR_ENABLED === '1' && isMicrosoftCalendarConfigured();
}
