// Business-day arithmetic for stage SLAs (#1638). PURE — no Prisma, no
// process.env — so it is unit-tested on its own (e2e/business-days.unit.spec.ts)
// and can run in the browser for a preview.
//
// THE RULE. "N business days from `from`" is the same wall-clock time on the
// N-th following local date that is a working day and not a holiday, in the
// given IANA zone:
//   · Thursday 17:00 + 3 business days = Tuesday 17:00 (Fri, Mon, Tue).
//   · A holiday only removes a day that would have counted. A public holiday
//     on a Saturday is already not a working day, so it cannot extend the
//     deadline a second time.
//   · Local dates and wall clocks come from the zone, never from the server
//     (which runs on UTC); the instant is solved back through Intl, so a DST
//     switch inside the window keeps 17:00 at 17:00.
// Zero or fewer days returns `from` unchanged.

export interface BusinessDayOptions {
  /** ISO weekdays that count: 1 = Monday … 7 = Sunday. */
  workingDays: ReadonlySet<number>;
  /** Local dates (YYYY-MM-DD, in `timeZone`) that never count. */
  holidays: ReadonlySet<string>;
  /** IANA zone the calendar is read in. */
  timeZone: string;
}

/** The working week most programmes mean: Monday to Friday. */
export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(date: Date, timeZone: string): WallClock {
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
  return { year: at('year'), month: at('month'), day: at('day'), hour: at('hour') % 24, minute: at('minute'), second: at('second') };
}

/** Milliseconds the zone's wall clock is ahead of UTC at instant `ts`. */
function offsetAt(ts: number, timeZone: string): number {
  const w = wallClock(new Date(ts), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ts / 1000) * 1000;
}

/** The instant that reads `w` on a clock in `timeZone` (two-pass offset solve, DST-safe). */
function instantOf(w: WallClock, timeZone: string, ms: number): Date {
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let ts = asUtc;
  for (let pass = 0; pass < 2; pass++) ts = asUtc - offsetAt(ts, timeZone);
  return new Date(ts + ms);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD of a calendar date held as a UTC midnight. */
function isoDate(utcMidnight: number): string {
  const d = new Date(utcMidnight);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date held as a UTC midnight. */
function isoWeekday(utcMidnight: number): number {
  const d = new Date(utcMidnight).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Is this local date a day that counts? */
export function isBusinessDay(localDate: string, opts: Pick<BusinessDayOptions, 'workingDays' | 'holidays'>): boolean {
  const [y, m, d] = localDate.split('-').map(Number);
  const midnight = Date.UTC(y, m - 1, d);
  return opts.workingDays.has(isoWeekday(midnight)) && !opts.holidays.has(localDate);
}

export function addBusinessDays(from: Date, days: number, opts: BusinessDayOptions): Date {
  if (!(days > 0)) return from;
  // A week with no working day would never end; treat it as Monday–Friday
  // rather than spin. The settings writer refuses an empty set anyway.
  const workingDays = opts.workingDays.size > 0 ? opts.workingDays : new Set(DEFAULT_WORKING_DAYS);
  const start = wallClock(from, opts.timeZone);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  let counted = 0;
  // Bounded: even a calendar of nothing but holidays gives up after ten years.
  for (let guard = 0; guard < 3660 && counted < days; guard++) {
    cursor += 24 * 60 * 60 * 1000;
    if (isBusinessDay(isoDate(cursor), { workingDays, holidays: opts.holidays })) counted++;
  }
  const target = new Date(cursor);
  return instantOf(
    { year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate(), hour: start.hour, minute: start.minute, second: start.second },
    opts.timeZone,
    ((from.getTime() % 1000) + 1000) % 1000
  );
}

/** Parse a stored working-days setting ("1,2,3,4,5"); anything unusable reads as Monday–Friday. */
export function parseWorkingDays(value: string | null | undefined): Set<number> {
  const days = new Set(
    String(value ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
  );
  return days.size > 0 ? days : new Set(DEFAULT_WORKING_DAYS);
}

/**
 * Parse a pasted holiday list (#1638): one `YYYY-MM-DD, label` per line (a
 * tab or semicolon also separates). Returns the rows it understood and the
 * line numbers it did not, so the screen can say which.
 */
export function parseHolidayList(text: string): { rows: { date: string; label: string }[]; rejected: number[] } {
  const rows: { date: string; label: string }[] = [];
  const rejected: number[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = /^(\d{4})-(\d{2})-(\d{2})\s*(?:[,;\t]\s*(.*))?$/.exec(line);
    if (!m) {
      rejected.push(i + 1);
      return;
    }
    const [, y, mo, d, label] = m;
    const t = Date.UTC(+y, +mo - 1, +d);
    const date = `${y}-${mo}-${d}`;
    if (Number.isNaN(t) || isoDate(t) !== date) {
      rejected.push(i + 1);
      return;
    }
    if (seen.has(date)) return;
    seen.add(date);
    rows.push({ date, label: (label ?? '').trim().slice(0, 120) });
  });
  return { rows, rejected };
}
