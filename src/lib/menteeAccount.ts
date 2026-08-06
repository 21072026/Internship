/**
 * Mentee records that are not (yet) accounts.
 *
 * A mentee a mentor types into the CRM is a *record* first: it is created with
 * a sentinel in the password column — never a bcrypt hash, so `bcrypt.compare`
 * can never match it — and, when the mentor doesn't know an address yet, a
 * generated stand-in e-mail on a domain that doesn't exist.
 *
 * Such a row can never sign in, and every recovery path is a dead end: both
 * `/api/auth/forgot` and `/api/admin/users/[id]/reset-password` only *mail* a
 * link, and that mail goes to the stand-in address. Registering with the real
 * address later creates a second, unrelated user, orphaning the interaction log
 * and stage history the mentor built up (#1123).
 *
 * `isPendingActivation` marks exactly the rows that a mentor/admin may still
 * correct and turn into a real login via `PATCH /api/mentor/mentees/[id]`.
 */

// Written by POST /api/mentor/mentees when a mentor adds a mentee by hand.
export const NO_LOGIN_PASSWORD = '!created-no-login';
// Written by scripts/import-csv.mjs for rows imported from the spreadsheet.
export const IMPORTED_NO_LOGIN_PASSWORD = '!imported-no-login';

const NO_LOGIN_PASSWORDS: readonly string[] = [NO_LOGIN_PASSWORD, IMPORTED_NO_LOGIN_PASSWORD];

// Generated stand-in addresses (mentor form + CSV import) live on this domain.
export const PLACEHOLDER_EMAIL_DOMAIN = 'import.local';
// What `anonymizeUser` rewrites an erased account's address to.
export const ERASED_EMAIL_DOMAIN = 'erased.local';

const REJECTED_EMAIL_DOMAINS: readonly string[] = [PLACEHOLDER_EMAIL_DOMAIN, ERASED_EMAIL_DOMAIN];

function domainOf(email: string) {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

/** The account has never had a password set, so nobody can sign in as it. */
export function isPendingActivation(user: { password: string }) {
  return NO_LOGIN_PASSWORDS.includes(user.password);
}

/** A generated stand-in address rather than a mailbox someone actually reads. */
export function isPlaceholderEmail(email: string) {
  return domainOf(email) === PLACEHOLDER_EMAIL_DOMAIN;
}

/**
 * Addresses that must never be *typed in* as the real one: the stand-in domain
 * (that's the state we're fixing) and the erasure domain (accepting it would
 * let someone re-address a record straight into the anonymised namespace).
 */
export function isUnusableEmail(email: string) {
  return REJECTED_EMAIL_DOMAINS.includes(domainOf(email));
}

/** An erased/anonymised record — activating it would resurrect it. */
export function isErasedAccount(user: { email: string }) {
  return domainOf(user.email) === ERASED_EMAIL_DOMAIN;
}
