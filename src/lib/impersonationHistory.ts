/**
 * "Who accessed my account" — turning the impersonation audit rows into
 * something the account holder can read (#1587).
 *
 * Impersonation already writes an `IMPERSONATE_START` row and (when the admin
 * returns properly) a matching `IMPERSONATE_STOP` row. The person whose account
 * was entered is the one party who could not see any of it after the single
 * in-app notification scrolled away. This module is the pure half of the fix:
 * it pairs those rows into readable sessions. The endpoint that feeds it
 * (`/api/account/impersonations`) reads `session.user.id` and nothing else.
 *
 * Deliberately Prisma-free so it can be reasoned about (and tested) on plain
 * objects.
 */

/**
 * Hard cap on an impersonated session, enforced in the JWT callback
 * (`src/lib/auth.ts`): past this the session auto-reverts to the admin. It is
 * exported here because the history quotes it — a start row with no stop row
 * cannot have lasted longer than this, and the UI says so.
 */
export const IMPERSONATION_SESSION_MAX_MS = 30 * 60 * 1000;

/**
 * How far back the history can reach, in days, or `null` while the rows are
 * kept indefinitely.
 *
 * This is not decoration: it decides which of two very different empty states
 * the user is shown. "Nobody has entered your account" is reassurance;
 * "nobody has entered it in the last N days" is a bounded statement, and
 * presenting the second as the first would be a quiet lie.
 *
 * `AuditLog` is NOT in the retention registry yet — it is one of the tables
 * queued behind #1585 (see the header of `src/lib/retentionEntries.ts`). When
 * that lands, set this to the same window that entry uses and the card's copy
 * switches by itself. It is a literal rather than a registry lookup on purpose:
 * importing `retentionEntries` would drag node-cron and the mail service into
 * an account-page request just to read one number.
 */
export const IMPERSONATION_HISTORY_RETENTION_DAYS: number | null = null;

/** Most recent sessions returned to the account page. */
export const IMPERSONATION_HISTORY_LIMIT = 50;

/** The subset of an `AuditLog` row this pairing needs. */
export interface ImpersonationAuditRow {
  id: string;
  actorId: string;
  action: string;
  detail: string | null;
  createdAt: Date;
}

/**
 * How a session finished, as far as the audit rows can honestly say.
 *
 *   - `closed`      — a matching stop row exists. The duration is exact.
 *   - `open`        — no stop row, and the start is still inside the 30-minute
 *                     cap, so the visit may be happening *right now*. The only
 *                     truthful statement is that no end has been recorded yet;
 *                     an absent stop row is not evidence the admin is present
 *                     (they may simply have closed the tab), so the copy must
 *                     not claim the session is active either.
 *   - `autoExpired` — no stop row and the cap has already passed, so the JWT
 *                     callback has certainly reverted it by now. This is the
 *                     only case where "ended automatically" is a fact.
 *
 * The distinction exists because it is free (`now` and the cap are both to
 * hand) and because getting it wrong made the card state something false about
 * a live session for a full thirty minutes.
 */
export type ImpersonationOutcome = 'closed' | 'open' | 'autoExpired';

/** One readable "somebody was in your account" entry. */
export interface ImpersonationSession {
  /** Id of the START row — stable, and never exposes the admin's id. */
  id: string;
  /**
   * Display name of the admin who entered, or `null` when their account no
   * longer exists. See the endpoint for why a name and only a name.
   */
  adminName: string | null;
  startedAt: string;
  /** ISO time of the matching stop row; `null` when the session was never closed. */
  endedAt: string | null;
  /**
   * Length of the visit in milliseconds, never above the 30-minute cap. Exact
   * for `closed`; an upper bound for the other two outcomes, and for `open` it
   * is only "so far" — the UI does not quote it as a duration there.
   */
  durationMs: number;
  /** See {@link ImpersonationOutcome} — never a claim the session IS active. */
  outcome: ImpersonationOutcome;
  /** Reason the admin typed, when they typed one. */
  reason: string | null;
}

export const IMPERSONATE_START = 'IMPERSONATE_START';
export const IMPERSONATE_STOP = 'IMPERSONATE_STOP';

/**
 * Pair start/stop rows for one target user into sessions, newest first.
 *
 * `rows` must be the target's `IMPERSONATE_*` rows in ascending time order.
 * Pairing is per admin (`actorId`), because two admins can hold overlapping
 * sessions on the same account and a stop row only ever closes its own admin's
 * start. Three cases are handled explicitly:
 *
 *   - a stop with no open start (its start fell outside the window, or was
 *     pruned) is dropped rather than invented into a zero-length session;
 *   - a second start from the same admin closes the first one as auto-expired
 *     (that one is definitively over whatever the clock says — the same admin
 *     is demonstrably somewhere else), bounded by the newer start's time;
 *   - anything still open at the end is `open` while it is inside the cap and
 *     `autoExpired` once the cap has passed, with the elapsed time clamped.
 */
export function pairImpersonationSessions(
  rows: ImpersonationAuditRow[],
  adminNames: Map<string, string>,
  now: number = Date.now(),
): ImpersonationSession[] {
  const open = new Map<string, ImpersonationAuditRow>();
  const sessions: ImpersonationSession[] = [];

  // `supersededBy` is the later start from the same admin that proves an
  // unclosed session is over; it also bounds its duration far better than
  // `now` does.
  const close = (
    start: ImpersonationAuditRow,
    stop: ImpersonationAuditRow | null,
    supersededBy: ImpersonationAuditRow | null = null,
  ) => {
    const startedMs = start.createdAt.getTime();
    const endBound = stop?.createdAt.getTime() ?? supersededBy?.createdAt.getTime() ?? now;
    const elapsed = endBound - startedMs;
    const outcome: ImpersonationOutcome = stop
      ? 'closed'
      : supersededBy || now - startedMs >= IMPERSONATION_SESSION_MAX_MS
        ? 'autoExpired'
        : 'open';
    sessions.push({
      id: start.id,
      adminName: adminNames.get(start.actorId) ?? null,
      startedAt: start.createdAt.toISOString(),
      endedAt: stop ? stop.createdAt.toISOString() : null,
      // Clamp both ends: a clock skew must not produce a negative duration, and
      // an unclosed session cannot have outlived the cap that ends it.
      durationMs: Math.min(Math.max(elapsed, 0), IMPERSONATION_SESSION_MAX_MS),
      outcome,
      reason: start.detail?.trim() ? start.detail.trim() : null,
    });
  };

  for (const row of rows) {
    if (row.action === IMPERSONATE_START) {
      const previous = open.get(row.actorId);
      if (previous) close(previous, null, row);
      open.set(row.actorId, row);
    } else if (row.action === IMPERSONATE_STOP) {
      const start = open.get(row.actorId);
      if (!start) continue;
      open.delete(row.actorId);
      close(start, row);
    }
  }
  for (const start of open.values()) close(start, null);

  return sessions.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}
