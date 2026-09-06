/**
 * Localized reason for a request the server rejected.
 *
 * The **status** is the only part of a failure this app puts in front of a user.
 * Every 4xx body on the routes these call sites reach carries a hardcoded
 * English literal — `'Unauthorized'`, `'Forbidden'`, `'Not found'`,
 * `'Interaction not found'`, `'Validation failed'` — so rendering `body.error`
 * would hand a Turkish or German mentor an English toast, and would publish
 * whatever text a future route happens to put there. Same stance as
 * `@/lib/authErrors`: a server-authored message is never shown verbatim.
 *
 * A status that carries genuinely request-specific detail the client cannot
 * reconstruct is read at its own call site instead — see the 409 `code:
 * 'overlap'` branch in the availability add-form, which names the interval it
 * collided with.
 */
export interface ApiErrorCopy {
  /** 401 — the session is gone, so retrying as-is cannot work. */
  sessionExpired: string;
  /** 403 — signed in, but this row is not the caller's to touch. */
  forbidden: string;
  /** 404 — the row is already gone; the screen is out of date, not the user. */
  alreadyGone: string;
}

/** `fallback` is the caller's own localized "this did not work" line. */
export function apiErrorMessage(res: Response, copy: ApiErrorCopy, fallback: string): string {
  if (res.status === 401) return copy.sessionExpired;
  if (res.status === 403) return copy.forbidden;
  if (res.status === 404) return copy.alreadyGone;
  return fallback;
}
