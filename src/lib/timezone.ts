// Timezone handling for date/times that cross the browser ↔ server boundary,
// in both directions: rendering an instant *out* (emails, stored notification
// text) and parsing a user-entered wall clock *in*.
//
// The browser picks the viewer's zone on its own (see lib/relativeTime.ts), but
// the server has no such context: the container runs on UTC, so a plain
// `toLocaleString()` rendered a 09:00 Europe/Berlin meeting as "07:00" in the
// reminder email while the app showed 09:00 (#1030). Every server-rendered
// timestamp therefore has to name an explicit zone.
//
// Resolution order: the recipient's saved `User.timezone` → the deployment
// default (`APP_TIMEZONE`) → Europe/Istanbul.

export const FALLBACK_TIMEZONE = 'Europe/Istanbul';

export function isValidTimeZone(tz?: string | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Deployment-wide default for recipients who never saved a zone.
export function appTimeZone(): string {
  const configured = process.env.APP_TIMEZONE;
  return isValidTimeZone(configured) ? configured : FALLBACK_TIMEZONE;
}

export function resolveTimeZone(tz?: string | null): string {
  return isValidTimeZone(tz) ? tz : appTimeZone();
}

// "GMT+3" — appended to every rendered time so a recipient in another zone can
// see which clock the time refers to instead of guessing.
export function zoneLabel(date: Date, tz?: string | null): string {
  const timeZone = resolveTimeZone(tz);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(date);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
}

// Absolute date+time in the recipient's zone, e.g. "2 Aug 2026, 09:00 (GMT+3)".
// `options` overrides the date/time style; note Intl forbids mixing
// dateStyle/timeStyle with individual component options, which is why the zone
// is appended as text rather than passed as `timeZoneName`.
export function formatInTimeZone(
  date: Date,
  tz?: string | null,
  options?: Intl.DateTimeFormatOptions,
  locale = 'en-GB'
): string {
  const timeZone = resolveTimeZone(tz);
  const formatted = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
    timeZone,
  }).format(date);
  const label = zoneLabel(date, timeZone);
  return label ? `${formatted} (${label})` : formatted;
}

// Do two zones put the same clock on the wall right now? Compared by offset, not
// by name: an organizer on "Europe/Berlin" and an attendee on "Europe/Paris"
// read the identical time, and repeating it as if it were a second reading is
// noise. Both sides go through resolveTimeZone first, so an unset zone compares
// as the deployment default rather than as "different".
export function sameWallClock(a: string | null | undefined, b: string | null | undefined, at: Date): boolean {
  const [za, zb] = [resolveTimeZone(a), resolveTimeZone(b)];
  return za === zb || offsetAt(at, za) === offsetAt(at, zb);
}

// ---------------------------------------------------------------------------
// The other direction: a *wall clock* the user typed → the instant they meant.
// ---------------------------------------------------------------------------

// `<input type="date">` + `<input type="time">` (and `datetime-local`) yield a
// bare wall clock with no zone: "2026-08-03T16:30". `new Date()` reads that in
// the *runtime's* local zone, so the same string means different instants in the
// browser and on the server — and our server runs UTC. An organizer in Germany
// picking 16:30 got a meeting stored at 16:30Z, i.e. 18:30 on their own clock
// (#1061). Anything sent to the server therefore has to carry a zone.
// The time is optional so a date on its own means local midnight in the zone,
// rather than the UTC midnight `new Date('2026-08-03')` would give.
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

// Does the string already pin an instant ("…Z", "…+02:00")? Only these are safe
// to hand to `new Date()` directly. The designator has to follow a *time* — a
// plain "2026-08-03" ends in digits preceded by "-" and would otherwise read as
// a "-08:03" offset.
const ZONED = /[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export function hasTimeZoneDesignator(value: string): boolean {
  return ZONED.test(value.trim());
}

// What is `timeZone` offset from UTC at this instant, in ms? Positive east of
// Greenwich. Derived from Intl so the IANA database (and its DST rules) is the
// single source of truth — no offset tables of our own to keep current.
function offsetAt(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = at('hour') % 24;
  const wall = Date.UTC(at('year'), at('month') - 1, at('day'), hour, at('minute'), at('second'));
  return wall - date.getTime();
}

// Read a bare wall clock as an instant in `tz` (falling back to the deployment
// default). Returns null if the string isn't a wall clock we recognise.
//
// The offset we need depends on the very instant we're solving for (DST), so
// resolve it iteratively: guess the wall clock is UTC, correct by the offset
// there, then correct once more. Two passes are exact for every zone whose
// offset shifts by less than the ~1h we're already within after the first pass.
export function parseWallClockInZone(value: string, tz?: string | null): Date | null {
  const m = WALL_CLOCK.exec(value.trim());
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m;
  const asUtc = Date.UTC(+year, +month - 1, +day, hour ? +hour : 0, minute ? +minute : 0, second ? +second : 0);
  const timeZone = resolveTimeZone(tz);
  let ts = asUtc;
  for (let pass = 0; pass < 2; pass++) ts = asUtc - offsetAt(new Date(ts), timeZone);
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Accepts either form and always returns a real instant: zone-qualified input is
// taken at face value, a bare wall clock is anchored to `tz`. Use this wherever
// an API takes a user-entered date/time.
export function parseUserDateTime(value: string, tz?: string | null): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (hasTimeZoneDesignator(trimmed)) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return parseWallClockInZone(trimmed, tz);
}

// Browser-side counterpart: turn the two form fields into a zone-qualified
// instant, read in the *viewer's* own zone — which is the clock they picked the
// time on. Safe to call in a client component; `new Date(y, m, …)` is local by
// definition, so no Intl round-trip is needed here.
export function wallClockToInstantISO(date: string, time: string): string {
  const m = WALL_CLOCK.exec(`${date}T${time}`);
  if (!m) return '';
  const [, year, month, day, hour, minute, second] = m;
  const local = new Date(+year, +month - 1, +day, hour ? +hour : 0, minute ? +minute : 0, second ? +second : 0, 0);
  return Number.isNaN(local.getTime()) ? '' : local.toISOString();
}

// ---------------------------------------------------------------------------
// Who reads this instant as what? (#1210)
// ---------------------------------------------------------------------------

// One instant is one instant, but the people in a meeting each see a different
// clock. Before an invite goes out the organizer should be able to *confirm*
// the time on every attendee's clock rather than assume everyone is on theirs —
// which is the whole ask behind #1210. Attendees on the same offset collapse
// into one row: three people in Berlin, Paris and Madrid are one reading.
export interface ZonedPerson {
  name: string;
  timezone?: string | null;
}

export interface ZoneReading {
  /** The resolved IANA zone of the first person in the group. */
  timeZone: string;
  /** "GMT+2" at this instant. */
  offsetLabel: string;
  /** The instant on this group's clock, e.g. "Sun 3 Aug, 16:30". */
  when: string;
  names: string[];
}

// Sorted west → east so the readings run in a stable, scannable order rather
// than in whatever order the attendee list happened to arrive in.
export function readingsByZone(instant: Date, people: ZonedPerson[], locale = 'en-GB'): ZoneReading[] {
  const groups = new Map<number, ZoneReading>();
  for (const person of people) {
    const timeZone = resolveTimeZone(person.timezone);
    const offset = offsetAt(instant, timeZone);
    const existing = groups.get(offset);
    if (existing) {
      if (!existing.names.includes(person.name)) existing.names.push(person.name);
      continue;
    }
    groups.set(offset, {
      timeZone,
      offsetLabel: zoneLabel(instant, timeZone),
      when: new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone,
      }).format(instant),
      names: [person.name],
    });
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, reading]) => reading);
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

// Enough of a spread to cover the people this app actually has when the runtime
// has no zone list of its own (very old ICU builds) — never the only path in a
// modern browser or Node.
const FALLBACK_ZONE_LIST = [
  'Europe/Istanbul', 'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'Europe/Amsterdam',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Tokyo', 'UTC',
];

let cachedZones: string[] | null = null;

/** Every IANA zone the runtime knows, memoized — the list is ~450 strings. */
export function supportedTimeZones(): string[] {
  if (cachedZones) return cachedZones;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zones = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined;
    cachedZones = zones && zones.length > 0 ? zones : FALLBACK_ZONE_LIST;
  } catch {
    cachedZones = FALLBACK_ZONE_LIST;
  }
  return cachedZones;
}

/** `<Select>` options for the zone picker. */
export function timeZoneOptions(): { value: string; label: string }[] {
  return supportedTimeZones().map((tz) => ({ value: tz, label: tz }));
}

/**
 * The zone this browser is in, or null on the server / when Intl has no data.
 * Deliberately not a fallback to the deployment default: callers need to tell
 * "the browser says Europe/Berlin" apart from "nobody knows".
 */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
