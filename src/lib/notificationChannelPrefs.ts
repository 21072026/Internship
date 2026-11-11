// Who gets what, where and when (#1714) — the channel axis of notification
// preferences, quiet hours and blackout dates. Pure and dependency-free (type
// imports only): the router (src/lib/notifications/router.ts) enforces it, the
// account API validates against it, the unit spec pins it.
//
// STORAGE. Inside the existing `User.notificationPrefs` JSON, next to the
// category switches — no table, no migration:
//
//   { "deadlines": true,                                   // category switch, unchanged
//     "channels": { "deadlines": { "email": false, "push": true } },  // SPARSE overrides
//     "quietHours": { "start": "21:00", "end": "08:00", "tz": "Europe/Istanbul" } }
//
// SPARSE ON PURPOSE. An absent category or channel resolves to the catalogue's
// `defaultChannels`, so every account that never touched the matrix behaves
// exactly as before. The CATEGORY switch outranks the matrix: a category turned
// off silences every channel (the router checks it first). E-mail additionally
// keeps its own e-mail-group taxonomy (emailGroups.ts) — the matrix can only
// take e-mail AWAY for a category, never re-subscribe a group somebody left.
//
// QUIET HOURS AND BLACKOUT DATES do not drop anything: a delivery that would
// interrupt (e-mail, push, chat) inside a quiet window or on an org blackout
// day is re-scheduled to the next open instant. The in-app bell row is never
// deferred — it interrupts nobody. Essential (account_security) events ignore
// the matrix, the quiet hours and the blackout days alike.

import type { NotificationCategory } from '@/lib/notificationPrefs';

export const MATRIX_CHANNELS = ['inApp', 'email', 'push'] as const;
export type MatrixChannel = (typeof MATRIX_CHANNELS)[number];
/** Channels whose delivery interrupts the reader and therefore waits out quiet hours. */
export const DEFERRABLE_CHANNELS: readonly string[] = ['email', 'push', 'chat'];

export type ChannelMap = Partial<Record<NotificationCategory, Partial<Record<MatrixChannel, boolean>>>>;

export interface QuietHours {
  /** "HH:MM", local to `tz`. */
  start: string;
  end: string;
  /** IANA zone; absent → the account's own `User.timezone`, else UTC. */
  tz?: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function prefsObject(prefs: unknown): Record<string, unknown> {
  return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? (prefs as Record<string, unknown>) : {};
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The stored channel map, keeping only well-formed booleans. */
export function readChannelMap(prefs: unknown, categories: readonly string[]): ChannelMap {
  const raw = prefsObject(prefsObject(prefs).channels);
  const out: Record<string, Partial<Record<MatrixChannel, boolean>>> = {};
  for (const [cat, entry] of Object.entries(raw)) {
    if (!categories.includes(cat)) continue;
    const e = prefsObject(entry);
    const row: Partial<Record<MatrixChannel, boolean>> = {};
    for (const ch of MATRIX_CHANNELS) if (typeof e[ch] === 'boolean') row[ch] = e[ch] as boolean;
    if (Object.keys(row).length) out[cat] = row;
  }
  return out as ChannelMap;
}

export function readQuietHours(prefs: unknown): QuietHours | null {
  const q = prefsObject(prefsObject(prefs).quietHours);
  if (typeof q.start !== 'string' || typeof q.end !== 'string' || !HHMM.test(q.start) || !HHMM.test(q.end) || q.start === q.end) return null;
  return { start: q.start, end: q.end, ...(isValidTimeZone(q.tz) ? { tz: q.tz } : {}) };
}

/**
 * The channels an event is attempted on for this person: the catalogue's
 * defaults plus push when they explicitly turned it on for the category. Push
 * is the only channel the matrix can ADD — an event that sends no mail by
 * design does not start mailing, and one with no bell row (a digest, a report)
 * does not grow one. A channel switched OFF stays in the list on purpose: the
 * router records it as SKIPPED `channel_off` (channelOffInMatrix), so "why did
 * I not get that mail?" has an answer in the ledger.
 */
export function resolveChannels<C extends string>(map: ChannelMap, category: NotificationCategory, defaults: readonly C[]): C[] {
  const out = [...defaults];
  if (map[category]?.push === true && !out.includes('push' as C)) out.push('push' as C);
  return out;
}

/** Explicitly switched off in the matrix? (Absent = allowed.) */
export function channelOffInMatrix(map: ChannelMap, category: NotificationCategory, channel: string): boolean {
  return (map[category] as Record<string, boolean | undefined> | undefined)?.[channel] === false;
}

// ── Quiet hours and blackout days ───────────────────────────────────────────

export interface Calendar {
  quiet: QuietHours | null;
  /** The zone the quiet window and the blackout days are read in. */
  tz: string;
  /** Org blackout days, `YYYY-MM-DD`, local to `tz`. */
  blackoutDates: readonly string[];
  blackoutWeekends: boolean;
}

function localParts(at: Date, tz: string): { date: string; minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is this instant closed — inside the quiet window or on a blackout day? */
export function isClosed(at: Date, cal: Calendar): boolean {
  const p = localParts(at, cal.tz);
  if (cal.blackoutDates.includes(p.date)) return true;
  if (cal.blackoutWeekends && (p.weekday === 0 || p.weekday === 6)) return true;
  if (cal.quiet) {
    const s = toMinutes(cal.quiet.start);
    const e = toMinutes(cal.quiet.end);
    // A window across midnight (21:00 → 08:00) is "after start OR before end".
    const inside = s < e ? p.minutes >= s && p.minutes < e : p.minutes >= s || p.minutes < e;
    if (inside) return true;
  }
  return false;
}

const STEP_MS = 5 * 60 * 1000;
/** Far enough for a long holiday plus a weekend; beyond it a delivery is not held. */
const MAX_HOLD_MS = 16 * 24 * 60 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

/**
 * The first open instant at or after `now`, or null when `now` is open (send
 * now). Walks forward in five-minute steps, then back minute by minute to the
 * exact edge (a quiet window ends on any HH:MM), and never holds a delivery
 * longer than MAX_HOLD_MS: a calendar that is closed for weeks (every day a
 * blackout) releases rather than swallows.
 */
export function nextOpenInstant(now: Date, cal: Calendar): Date | null {
  if (!isClosed(now, cal)) return null;
  const floor = Math.ceil(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const start = Math.ceil(now.getTime() / STEP_MS) * STEP_MS;
  for (let t = start; t - now.getTime() <= MAX_HOLD_MS; t += STEP_MS) {
    if (isClosed(new Date(t), cal)) continue;
    let open = t;
    while (open - MINUTE_MS >= floor && !isClosed(new Date(open - MINUTE_MS), cal)) open -= MINUTE_MS;
    return new Date(open);
  }
  return new Date(now.getTime() + MAX_HOLD_MS);
}

/** Org blackout days from the stored setting: comma/space separated `YYYY-MM-DD`, junk dropped. */
export function parseBlackoutDates(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
    .slice(0, 366);
}
