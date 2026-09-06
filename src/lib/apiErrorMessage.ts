/**
 * Turn a failed `fetch` Response into a message worth putting in front of a user.
 *
 * A 4xx body's `error` is a statement about *this* request — "Forbidden",
 * "Interaction not found" — and is worth surfacing: it tells the user why
 * retrying will not help. A 5xx body's is an internal detail ("Internal server
 * error") that says nothing actionable and can leak implementation, so those
 * collapse to the caller's localized fallback, as does an unparseable body.
 *
 * Callers pass a localized `fallback` (e.g. `t.common.deleteFailed`) so the
 * generic case is never English-only.
 */
export async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  if (res.status >= 500) return fallback;
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const reason = typeof body?.error === 'string' ? body.error.trim() : '';
  return reason || fallback;
}
