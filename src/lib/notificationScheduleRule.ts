// Who gets what, where and WHEN (#1714) — the pure half: the per-category
// channel matrix, per-user quiet hours and per-org blackout dates. Unit-tested
// in scripts/test/notification-schedule.test.mjs; enforced in ONE place, the
// router (src/lib/notifications/router.ts). Doc: docs/notification-schedule.md.
//
// WHERE IT LIVES. Both per-user settings sit inside the existing
// `User.notificationPrefs` JSON, next to the boolean category/group switches:
//
//   { "deadlines": true,                                  // category switch (unchanged)
//     "channels": { "deadlines": { "email": false } },   // SPARSE overrides
//     "quietHours": { "start": "21:00", "end": "08:00" } }
//
// SPARSE ON PURPOSE. An absent entry means "the catalogue's defaultChannels",
// so an account with no `channels` key behaves exactly as before, and nobody
// who opted out through a legacy key is re-subscribed by a migration that
// never runs. The category switch OUTRANKS the matrix: a category that is off
// is off on every channel, whatever the matrix says.
//
// QUIET HOURS AND BLACKOUTS RESCHEDULE, THEY NEVER DROP. A delivery that falls
// inside either is moved to the next open instant (`nextOpenInstant`), once.
// They hold back the channels that interrupt somebody (e-mail today, push when
// it lands, #1715) — never the in-app bell, which waits silently for the next
// visit anyway — and never the essential `account_security` group.
//
// The quiet window is read on the RECIPIENT's clock (`User.timezone`, falling
// back to the deployment zone); never guessed from a browser on the server.

import { offsetAt } from './timezone';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const MAX_BLACKOUT_DATES = 366;

export interface QuietHours {
  start: string;
  end: string;
}

export interface OpenWindowRules {
  quiet: QuietHours | null;
  /** 'YYYY-MM-DD' dates, on the recipient's clock. */
  blackoutDates: readonly string[];
  /** Saturday and Sunday are closed too. */
  weekends: boolean;
  /** The IANA zone the rules are read in. */
  tz: string;
}

function prefsObject(prefs: unknown): Record<string, unknown> {
  return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? (prefs as Record<string, unknown>) : {};
}

// ── The channel matrix ──────────────────────────────────────────────────────

/** A channel is off for a category only when the matrix says `false` for it. */
export function channelPrefAllowed(prefs: unknown, category: string, channel: string): boolean {
  const channels = prefsObject(prefsObject(prefs).channels);
  const row = prefsObject(channels[category]);
  return row[channel] !== false;
}

/**
 * A matrix from a request, reduced to what the caller may store: known
 * categories × known channels × booleans, nothing else. Unknown keys are
 * dropped rather than refused so an older client cannot break a save.
 */
export function sanitizeChannelMatrix(
  input: unknown,
  categories: readonly string[],
  channels: readonly string[],
): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = Object.create(null);
  const src = prefsObject(input);
  for (const cat of categories) {
    const row = prefsObject(src[cat]);
    const kept: Record<string, boolean> = Object.create(null);
    for (const ch of channels) if (typeof row[ch] === 'boolean') kept[ch] = row[ch] as boolean;
    if (Object.keys(kept).length) out[cat] = { ...kept };
  }
  return { ...out };
}

/** The channels this category travels on for this person: defaults minus the matrix's `false`s. */
export function resolveChannels(prefs: unknown, category: string, defaults: readonly string[]): string[] {
  return defaults.filter((ch) => channelPrefAllowed(prefs, category, ch));
}

// ── Quiet hours ─────────────────────────────────────────────────────────────

export function parseQuietHours(value: unknown): QuietHours | null {
  const q = prefsObject(value);
  if (typeof q.start !== 'string' || typeof q.end !== 'string') return null;
  if (!HHMM.test(q.start) || !HHMM.test(q.end) || q.start === q.end) return null;
  return { start: q.start, end: q.end };
}

/** The stored quiet window of a prefs blob, or null. */
export function quietHoursOf(prefs: unknown): QuietHours | null {
  return parseQuietHours(prefsObject(prefs).quietHours);
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Is a local minute-of-day inside the window? A window may wrap past midnight. */
export function inQuietWindow(minuteOfDay: number, q: QuietHours): boolean {
  const s = minutesOf(q.start);
  const e = minutesOf(q.end);
  return s < e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
}

// ── Blackout dates ──────────────────────────────────────────────────────────

/** A stored list (comma/space/newline separated), reduced to valid unique dates, sorted. */
export function parseBlackoutDates(raw: unknown): string[] {
  const items = typeof raw === 'string' ? raw.split(/[\s,;]+/) : Array.isArray(raw) ? raw : [];
  const out = new Set<string>();
  for (const it of items) {
    if (typeof it !== 'string') continue;
    const v = it.trim();
    if (ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)) out.add(v);
  }
  return [...out].sort().slice(0, MAX_BLACKOUT_DATES);
}

export function serializeBlackoutDates(dates: readonly string[] | string): string {
  return parseBlackoutDates(typeof dates === 'string' ? dates : [...dates]).join(',');
}

// ── The next open instant ───────────────────────────────────────────────────

interface Local {
  date: string; // YYYY-MM-DD
  weekday: number; // 0 = Sunday
  minute: number; // minute of day
}

function local(at: Date, tz: string): Local {
  const wall = new Date(at.getTime() + offsetAt(at, tz));
  return {
    date: wall.toISOString().slice(0, 10),
    weekday: wall.getUTCDay(),
    minute: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
  };
}

/** The instant a local wall clock (date + minute of day) names in `tz`. */
function instantAt(date: string, minute: number, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, Math.floor(minute / 60), minute % 60);
  let ts = asUtc;
  for (let pass = 0; pass < 2; pass++) ts = asUtc - offsetAt(new Date(ts), tz);
  return new Date(ts);
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * `now` when it is open; otherwise the first instant that is outside the quiet
 * window, not on a blackout date and (with `weekends`) not on a Saturday or
 * Sunday — all on the recipient's clock. Bounded: if every day of the next
 * ~13 months is closed (a misconfiguration), the rules are ignored and `now`
 * is returned, because a notification must never be held forever.
 */
export function nextOpenInstant(now: Date, rules: OpenWindowRules): Date {
  const closed = new Set(rules.blackoutDates);
  let at = now;
  for (let i = 0; i < 800; i++) {
    const l = local(at, rules.tz);
    if (closed.has(l.date) || (rules.weekends && (l.weekday === 0 || l.weekday === 6))) {
      at = instantAt(nextDate(l.date), 0, rules.tz);
      continue;
    }
    if (rules.quiet && inQuietWindow(l.minute, rules.quiet)) {
      const end = minutesOf(rules.quiet.end);
      // The window ends today if its end is still ahead on this local day, else tomorrow.
      const day = l.minute < end ? l.date : nextDate(l.date);
      const next = instantAt(day, end, rules.tz);
      // DST can make a wall clock land at or before `at`; step a minute past it.
      at = next.getTime() > at.getTime() ? next : new Date(at.getTime() + 60_000);
      continue;
    }
    return at;
  }
  return now;
}
