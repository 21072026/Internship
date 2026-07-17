// Google Calendar integration config & gating (#417).
//
// EPIC D's core meeting/RSVP/calendar/.ics/reminder features are shipped. This
// module covers the remaining acceptance item — user-consented Google Calendar
// OAuth — as far as it can go WITHOUT the operator's Google Cloud credentials
// and a testable OAuth round-trip: config detection + a pure consent-URL
// builder. The token-storing callback + event push are wired once credentials
// exist and can be exercised in a preview env (see docs/google-calendar.md),
// exactly like the SSO slice (#545).
//
// No secrets are hard-coded; everything reads from env.

// OAuth scopes: manage the user's own calendar events (create Meet links, push
// meetings). Requested only when the user explicitly connects — the app never
// creates a Google account or acts without consent.
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
];

export function googleClientId(): string | null {
  return process.env.GOOGLE_CLIENT_ID || null;
}

export function googleRedirectUri(): string | null {
  if (process.env.GOOGLE_OAUTH_REDIRECT_URI) return process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const base = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL;
  return base ? `${base.replace(/\/$/, '')}/api/integrations/google/callback` : null;
}

// The integration is "configured" when the operator has provided a Google OAuth
// client. Until then the connect flow is inert and the UI shows setup guidance.
export function isGoogleCalendarConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && googleRedirectUri());
}

// Build the Google OAuth consent URL (pure — no network). `state` is an opaque
// CSRF/anti-replay token the caller persists and re-checks on callback. Returns
// null when the integration isn't configured.
export function googleConsentUrl(state: string): string | null {
  const clientId = googleClientId();
  const redirectUri = googleRedirectUri();
  if (!clientId || !redirectUri) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    // offline + consent so Google returns a refresh token we can store.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
