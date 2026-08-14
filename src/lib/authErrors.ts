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
