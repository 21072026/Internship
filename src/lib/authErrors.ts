// Shared between the NextAuth config (server) and the sign-in page (client),
// so keep this module free of server-only imports — importing `@/lib/auth`
// from a client component would drag Prisma into the browser bundle.

/**
 * Stable code the sign-in page renders as a localized "something went wrong"
 * message. NextAuth hands a thrown authorize() error's `.message` straight to
 * the browser as `?error=<message>`; without this indirection an internal fault
 * is shown verbatim to the user. That is how a corrupt `Json` column in a user
 * row surfaced as "Unexpected end of JSON input" on the login form (#1150) —
 * meaningless to the user, and more than an attacker should learn.
 */
export const AUTH_UNEXPECTED_ERROR = 'UNEXPECTED_ERROR';

/**
 * The infrastructure is down rather than the request being wrong — the database
 * is unreachable, out of connections, or still starting up. Distinct from
 * AUTH_UNEXPECTED_ERROR because the honest advice differs: "try again in a
 * moment" is actually true here, and the sign-in page says so without ever
 * naming the host, port or driver (which is what a raw
 * "Can't reach database server at `localhost:3306`" did).
 */
export const AUTH_SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE';

/**
 * The user's tenant has enforced single sign-on (#1950), so no password-derived
 * path may mint a session for them. Distinct from "Invalid email or password"
 * on purpose: the password is not wrong, it is switched off, and the only
 * useful thing to say is "go to your identity provider" — which the sign-in
 * page turns into a link to `/auth/sso`.
 *
 * This is a deliberate, narrow enumeration trade: it reveals that an address
 * belongs to an SSO-enforced organization. Recorded in
 * `docs/security-exceptions.md` rather than left implicit.
 */
export const AUTH_SSO_REQUIRED = 'SSO_REQUIRED';

/**
 * The errors authorize() raises on purpose. Their text is contractual: the
 * sign-in page keys off it to show the 2FA field, offer a resend link, or
 * explain a pending review, and renders the rest as-is.
 *
 * This is an allow-list in BOTH directions, and both directions are load
 * bearing:
 *  - server side, anything not in here is an internal fault and is replaced by
 *    a stable code (see toClientAuthError in `@/lib/auth`);
 *  - client side, anything not in here is never rendered, so a message that
 *    slips past the server guard — a NextAuth-generated error, a fault thrown
 *    outside authorize() — still cannot leak internals onto the form.
 */
export const INTENTIONAL_AUTH_ERRORS = new Set([
  'Email and password are required',
  'Invalid email or password',
  'Invalid authenticator code',
  'Too many attempts. Please try again later.',
  'This account has been deactivated. Please contact an administrator.',
  'grant is required',
  'Invalid or expired grant',
  'Invalid or expired SSO grant',
  'Target user not found',
  'User not found',
  '2FA_REQUIRED',
  'EMAIL_NOT_VERIFIED',
  'ACCOUNT_PENDING_APPROVAL',
  AUTH_SSO_REQUIRED,
]);
