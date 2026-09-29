/**
 * Read access logging: the repeat-view rule (#2433).
 *
 * "Who read this customer record?" is answered from `ActivityLog`. A READ of a
 * sensitive record writes one `<thing>.view` entry through `logActivity()`,
 * which means the same write path, the same table and the same retention window
 * (`activityLogRetentionDays`, pruned by the one retention job) as every other
 * entry. There is no `AccessLog` table and there must not be one: a second
 * ledger needs a second retention decision and a second erasure path, and would
 * only ever answer half the question.
 *
 * A read is not a write, though. An admin flicking between two companies, a tab
 * that re-fetches on focus, a double-click: each is the same fact ("A read B")
 * a few seconds apart, and one row per request would bury the entries an
 * incident review is looking for under their own echoes. So a repeat of the
 * SAME read inside a short window is suppressed. "The same read" means the same
 * action, actor, target, origin IP and detail. A read from a new IP is a new
 * fact (it is the one an incident review asks about), and so is a read made
 * through an impersonated account, which `attributeView()` marks in `detail`.
 *
 * The window comes from the setting `viewLogWindowMinutes` (src/lib/settings.ts,
 * default 15). `0` switches suppression off, so every read is a row. No value can
 * silence a FIRST read: the window only ever looks backwards from a row that
 * already exists, and a broken setting falls back to the default rather than
 * to "suppress everything".
 *
 * Suppression is best-effort, not a guarantee: two requests racing through the
 * check can both write. That costs one duplicate row. Making it exact would
 * take a unique constraint, i.e. a schema change, to filter noise.
 *
 * Failure never reaches the caller. A failed setting read uses the default, a
 * failed lookup RECORDS the view (a duplicate is cheaper than a missing read),
 * and a failed write is swallowed. The page the read belongs to always renders.
 *
 * Dependency-free on purpose (no Prisma, no settings import) so the whole rule,
 * failure paths included, is unit-tested: scripts/test/view-log-rule.test.mjs.
 * The Prisma-aware half is `logViewActivity()` in src/lib/activity.ts.
 */

/** Suppression window for a repeat view when nothing is configured. */
export const VIEW_LOG_WINDOW_DEFAULT_MINUTES = 15;

/**
 * Upper bound on the window. Past a day the filter stops removing echoes and
 * starts removing facts: "did A read B on Tuesday?" must stay answerable, so a
 * larger stored value is clamped here rather than honoured.
 */
export const VIEW_LOG_WINDOW_MAX_MINUTES = 24 * 60;

/**
 * Parse the stored setting. Digits only: `0` means "log every read", anything
 * above the cap is clamped to it, and a blank, negative or unparseable value
 * falls back to the default. A corrupted row must not be able to turn the
 * access log off, and it cannot, because no value here means "never log".
 */
export function parseViewLogWindowMinutes(raw: string | null | undefined): number {
  const value = (raw ?? '').trim();
  if (!/^\d{1,9}$/.test(value)) return VIEW_LOG_WINDOW_DEFAULT_MINUTES;
  return Math.min(Number(value), VIEW_LOG_WINDOW_MAX_MINUTES);
}

/**
 * The earliest `createdAt` an earlier identical entry may carry and still
 * suppress this one, or `null` when suppression is off.
 */
export function viewLogWindowStart(now: Date, windowMinutes: number): Date | null {
  if (!(windowMinutes > 0)) return null;
  return new Date(now.getTime() - windowMinutes * 60_000);
}

/**
 * `ActivityLog.detail` is a VARCHAR(191) column, and an oversized value makes
 * the insert fail (P2000), which logActivity() swallows: the read would leave
 * no row at all. What goes in it here is short by construction, but the cap is
 * applied anyway rather than trusted.
 */
export const ACTIVITY_DETAIL_MAX = 191;

/** The session user, as far as attributing a read needs it. */
export interface ViewReader {
  id: string;
  email?: string | null;
  /** Set while an admin is impersonating `id`: the admin's user id. */
  impersonatorId?: string | null;
}

/** The actor columns of a view entry. */
export interface ViewAttribution {
  actorId: string;
  actorEmail: string | null;
  detail: string | null;
}

/**
 * Who a read is attributed to: the REAL reader, always.
 *
 * While an admin impersonates a user the session is the user's, but the eyes
 * are the admin's. So the entry names the admin as actor (the same convention
 * as `impersonate.stop`, which logs `actorId: impersonatorId`) and `detail`
 * names the account the read was made through: `as <userId>`. Attributing it
 * to the user instead would bump their last-active date, put a read they never
 * made in their own activity feed, and hide it from a search of /admin/activity
 * by the admin's e-mail. Pageview tracking skips impersonated sessions for the
 * same reason ("that activity isn't the user's own").
 *
 * `impersonatorEmail` is looked up by the caller; `null` (not found, lookup
 * failed) still leaves the entry attributed to the right id.
 *
 * `detail` carries nothing else, and in particular NOT the record's name: the
 * activity feed is not tenant-scoped yet (ActivityLog has no `orgId`, #543), so
 * a name there would show one tenant's customer book to every other tenant's
 * admins. `targetId` already identifies the record. A different `detail` is
 * also a different repeat key, so an admin's own reads and the reads they make
 * through an impersonated account are never folded into one row.
 */
export function attributeView(reader: ViewReader, impersonatorEmail: string | null = null): ViewAttribution {
  if (reader.impersonatorId) {
    return {
      actorId: reader.impersonatorId,
      actorEmail: impersonatorEmail,
      detail: `as ${reader.id}`.slice(0, ACTIVITY_DETAIL_MAX),
    };
  }
  return { actorId: reader.id, actorEmail: reader.email ?? null, detail: null };
}

export type ViewLogOutcome =
  /** No identical entry inside the window, so the write was handed on. */
  | 'recorded'
  /** An identical entry already exists inside the window. */
  | 'suppressed'
  /** The writer threw. `logActivity` never does, but the guard is kept anyway. */
  | 'failed';

export interface RecordViewDeps {
  /** The configured window in minutes. May throw; the default is used then. */
  windowMinutes: () => Promise<number>;
  /** Whether an identical entry exists with `createdAt >= since`. May throw. */
  hasRecent: (since: Date) => Promise<boolean>;
  /** Write the entry. */
  write: () => Promise<void>;
  /** Injected clock, for the tests. */
  now?: () => Date;
}

/** Record a view unless an identical one is already inside the window. Never throws. */
export async function recordViewOnce(deps: RecordViewDeps): Promise<ViewLogOutcome> {
  const now = deps.now ? deps.now() : new Date();

  let minutes = VIEW_LOG_WINDOW_DEFAULT_MINUTES;
  try {
    minutes = await deps.windowMinutes();
  } catch {
    // Keep the default: the setting is a noise filter, not a precondition.
  }

  const since = viewLogWindowStart(now, minutes);
  if (since) {
    try {
      if (await deps.hasRecent(since)) return 'suppressed';
    } catch {
      // Could not tell whether this is a repeat, so record it. One duplicate
      // row is the cheap mistake here; a read that left no trace is the other.
    }
  }

  try {
    await deps.write();
    return 'recorded';
  } catch {
    return 'failed';
  }
}
