// Business-day arithmetic for stage SLAs (#1638) — THE implementation, pure.
//
// Plain ESM with JSDoc types on purpose: the app imports it through
// src/lib/businessDays.ts (allowJs, the stage-deadline-fill precedent), and
// the deploy's Node 20 can import it without a TypeScript step. One file, so
// the request path, the admin's SLA save and any backfill cannot disagree.
//
// THE RULE
//   `addBusinessDays(from, n, rule)` walks forward from the LOCAL calendar day
//   of `from` in `rule.timeZone`, counting only days whose weekday is in
//   `rule.workingDays` and whose date is not in `rule.holidays`, until it has
//   counted `n` of them. The deadline is that day at the same LOCAL wall-clock
//   time as `from`: a 3-business-day SLA started Thursday 17:00 is due Tuesday
//   17:00. Weekday and holiday are judged in the zone, never on the server's
//   clock, and the wall-clock time survives a DST change in between.
//
//   A holiday on a day that is not a working day changes nothing: that day was
//   never counted, so it cannot extend the deadline a second time.
//
//   `calendar` mode is NOT this function: the caller keeps `from + n × 24h`,
//   byte-identical to what the code did before #1638.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Monday–Friday, as JS weekdays (0 = Sunday). */
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];
/** A run of non-working days longer than this means a broken rule, not a long holiday. */
const MAX_SCAN_DAYS = 3660;

/** The offset of `timeZone` from UTC at `instant`, in ms (positive east of Greenwich). */
export function zoneOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const whole = Math.floor(new Date(instant).getTime() / 1000) * 1000;
  return asUtc - whole;
}

/** The local calendar day and wall-clock time of `instant` in `timeZone`. */
function localParts(instant, timeZone) {
  const local = new Date(new Date(instant).getTime() + zoneOffsetMs(instant, timeZone));
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth(),
    d: local.getUTCDate(),
    msOfDay: local.getUTCHours() * 3600000 + local.getUTCMinutes() * 60000 + local.getUTCSeconds() * 1000 + local.getUTCMilliseconds(),
  };
}

/** The instant whose local wall clock in `timeZone` is (y, m, d) + msOfDay. DST-safe. */
function zonedInstant(y, m, d, msOfDay, timeZone) {
  const guess = Date.UTC(y, m, d) + msOfDay;
  let instant = guess - zoneOffsetMs(guess, timeZone);
  // One correction: the offset at the guess and at the answer can differ
  // across a DST change.
  const corrected = guess - zoneOffsetMs(instant, timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/** `YYYY-MM-DD` of a UTC-midnight date number. */
function isoDay(utcMidnight) {
  return new Date(utcMidnight).toISOString().slice(0, 10);
}

/**
 * Add `days` working days to `from`.
 *
 * @param {Date | number | string} from
 * @param {number} days  whole working days, ≥ 0; 0 returns `from` unchanged
 * @param {{ workingDays?: readonly number[], holidays?: Iterable<string>, timeZone: string }} rule
 *        workingDays: JS weekdays (0 = Sunday); holidays: `YYYY-MM-DD` local dates
 * @returns {Date}
 */
export function addBusinessDays(from, days, rule) {
  const start = new Date(from);
  const n = Math.max(0, Math.floor(days));
  if (n === 0) return start;
  const working = new Set((rule.workingDays && rule.workingDays.length ? rule.workingDays : DEFAULT_WORKING_DAYS).filter((d) => d >= 0 && d <= 6));
  if (working.size === 0) throw new Error('addBusinessDays: no working day in the rule');
  const holidays = new Set(rule.holidays ?? []);
  const { y, m, d, msOfDay } = localParts(start, rule.timeZone);
  let day = Date.UTC(y, m, d);
  let counted = 0;
  for (let scanned = 0; counted < n; scanned++) {
    if (scanned > MAX_SCAN_DAYS) throw new Error('addBusinessDays: no working day within ten years');
    day += DAY_MS;
    const weekday = new Date(day).getUTCDay();
    if (working.has(weekday) && !holidays.has(isoDay(day))) counted++;
  }
  const target = new Date(day);
  return zonedInstant(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), msOfDay, rule.timeZone);
}

/**
 * The SLA deadline for a stage entered at `from` with `days` of service level,
 * in the given mode. `calendar` (the default) is exactly `from + days × 24h`.
 *
 * @param {Date | number | string} from
 * @param {number} days
 * @param {{ mode: 'calendar' | 'business', workingDays?: readonly number[], holidays?: Iterable<string>, timeZone: string } | null | undefined} rule
 * @returns {Date}
 */
export function slaDeadline(from, days, rule) {
  if (!rule || rule.mode !== 'business') return new Date(new Date(from).getTime() + days * DAY_MS);
  return addBusinessDays(from, days, rule);
}

/**
 * Parse a stored working-days list (`"1,2,3,4,5"`) into JS weekdays. Anything
 * unreadable, or a list with no valid day, reads as Monday–Friday.
 *
 * @param {string | null | undefined} raw
 * @returns {number[]}
 */
export function parseWorkingDays(raw) {
  const days = String(raw ?? '')
    .split(/[,\s]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const unique = Array.from(new Set(days)).sort((a, b) => a - b);
  return unique.length ? unique : [...DEFAULT_WORKING_DAYS];
}

/**
 * Parse a pasted holiday list: one `YYYY-MM-DD, label` per line (`;` or a tab
 * also separate; a line without a label gets the date as its label). Returns
 * the valid rows, de-duplicated by date (the first label wins), and the line
 * numbers that could not be read.
 *
 * @param {string} text
 * @returns {{ holidays: { date: string, label: string }[], invalidLines: number[] }}
 */
export function parseHolidayList(text) {
  const holidays = [];
  const seen = new Set();
  const invalidLines = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const match = /^(\d{4})-(\d{2})-(\d{2})\s*(?:[,;\t]\s*(.*))?$/.exec(trimmed);
      if (!match) return void invalidLines.push(i + 1);
      const [, ys, ms, ds, rawLabel] = match;
      const at = Date.UTC(Number(ys), Number(ms) - 1, Number(ds));
      const date = `${ys}-${ms}-${ds}`;
      if (Number.isNaN(at) || isoDay(at) !== date) return void invalidLines.push(i + 1);
      if (seen.has(date)) return;
      seen.add(date);
      const label = (rawLabel ?? '').trim().slice(0, 120) || date;
      holidays.push({ date, label });
    });
  return { holidays, invalidLines };
}
