// The pure half of the app's sign-in (#2775): how a NextAuth v4 credentials
// round-trip is encoded and read back. No fetch here, so `npm test` can pin it.
//
// The app mints NO session of its own. It drives the same HTTP flow the web
// sign-in page drives through next-auth/react — GET /api/auth/csrf, then a form
// POST to /api/auth/callback/<provider> with `json: true` — so every session is
// still minted by the one `jwt` callback in src/lib/auth.ts. The OS cookie jar
// (shared with the web view) holds the result, exactly as a browser would.

/** Error codes the server lets through (src/lib/authErrors.ts) that the app reacts to. */
export type SignInErrorCode =
  | 'TWO_FACTOR_REQUIRED'
  | 'PENDING_APPROVAL'
  | 'EMAIL_NOT_VERIFIED'
  | 'SSO_REQUIRED'
  | 'SERVICE_UNAVAILABLE'
  | 'WRONG_WORLD'
  | 'LOCKED'
  | 'BAD_CODE'
  | 'DEACTIVATED'
  | 'INVALID';

export function callbackBody(fields: Record<string, string>, csrfToken: string, callbackUrl: string): string {
  return new URLSearchParams({ ...fields, csrfToken, callbackUrl, json: 'true' }).toString();
}

/** next-auth/react reads the outcome from the `error` query param of the returned url. */
export function errorFromCallbackUrl(url: unknown): string | null {
  if (typeof url !== 'string') return 'INVALID';
  try {
    return new URL(url).searchParams.get('error');
  } catch {
    return 'INVALID';
  }
}

/**
 * Map a raw server code onto what the app shows. Raw codes are never rendered
 * (#1150): anything unrecognised is a plain "sign-in failed".
 */
export function classifySignInError(raw: string): SignInErrorCode {
  switch (raw) {
    case '2FA_REQUIRED':
      return 'TWO_FACTOR_REQUIRED';
    case 'ACCOUNT_PENDING_APPROVAL':
      return 'PENDING_APPROVAL';
    case 'EMAIL_NOT_VERIFIED':
      return 'EMAIL_NOT_VERIFIED';
    case 'SSO_REQUIRED':
      return 'SSO_REQUIRED';
    case 'SERVICE_UNAVAILABLE':
      return 'SERVICE_UNAVAILABLE';
  }
  if (raw.startsWith('WRONG_WORLD_')) return 'WRONG_WORLD';
  // The literal messages in INTENTIONAL_AUTH_ERRORS (src/lib/authErrors.ts).
  if (raw === 'Too many attempts. Please try again later.') return 'LOCKED';
  if (raw === 'Invalid authenticator code') return 'BAD_CODE';
  if (raw.startsWith('This account has been deactivated')) return 'DEACTIVATED';
  return 'INVALID';
}

export interface SessionUser {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
}

/** GET /api/auth/session answers `{}` when signed out. */
export function sessionUserFrom(body: unknown): SessionUser | null {
  const user = (body as { user?: Partial<SessionUser> } | null)?.user;
  if (!user || typeof user.id !== 'string' || typeof user.role !== 'string') return null;
  return { id: user.id, name: user.name ?? null, email: user.email ?? null, role: user.role };
}
