// Cron slot arithmetic for the scheduler (#1676) — pure, no imports, unit-tested
// in `e2e/job-scheduler.unit.spec.ts`.
//
// A "slot" is a minute an expression matches: `45 6 * * *` has one slot a day,
// at 06:45:00.000. The scheduler asks one question of an expression — "what is
// the latest slot at or before now, and is it newer than the last one I
// enqueued?" — and this file answers it without a dependency.
//
// TIMEZONE. Slots are computed in the PROCESS's local time (`getHours()` and
// friends), because that is what node-cron does when no `timezone` option is
// passed, and no schedule in the product passes one. The containers run in UTC,
// so every expression in `./schedules` reads as UTC — exactly as before the
// switchover. A process started with another `TZ` would move every schedule
// with it, for node-cron and for this file alike.
//
// SYNTAX. The five standard fields, each a comma list of `*`, `*/n`, `a`,
// `a-b` and `a-b/n`. Day-of-week takes 0-7 (0 and 7 are Sunday). No names
// (`MON`), no seconds field, no `L`/`W`/`#`. Day-of-month and day-of-week are
// combined with AND; the registry test asserts that no schedule restricts both,
// which is the one case where cron dialects disagree.

interface Field {
  min: number;
  max: number;
}

const FIELDS: Field[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week
];

export interface CronMatcher {
  expr: string;
  sets: Set<number>[];
  /** True when the day-of-month or day-of-week field is not `*`. */
  restrictsDom: boolean;
  restrictsDow: boolean;
}

function parseField(text: string, field: Field): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad cron field '${text}'`);
    const step = m[4] ? Number(m[4]) : 1;
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = field.min;
      hi = field.max;
    } else {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? field.max : lo;
    }
    if (step < 1 || lo < field.min || hi > field.max || lo > hi) throw new Error(`bad cron field '${text}'`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronMatcher {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expression needs 5 fields: '${expr}'`);
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]));
  // 7 is Sunday as well as 0.
  if (sets[4].has(7)) sets[4].add(0);
  return { expr, sets, restrictsDom: parts[2] !== '*', restrictsDow: parts[4] !== '*' };
}

/** Does `at` (local time, any seconds) fall in a minute the expression matches? */
export function matchesMinute(m: CronMatcher, at: Date): boolean {
  return (
    m.sets[0].has(at.getMinutes()) &&
    m.sets[1].has(at.getHours()) &&
    m.sets[2].has(at.getDate()) &&
    m.sets[3].has(at.getMonth() + 1) &&
    m.sets[4].has(at.getDay())
  );
}

const MINUTE = 60_000;

/** The start of the minute `at` falls in. */
export function floorMinute(at: Date): Date {
  const d = new Date(at.getTime());
  d.setSeconds(0, 0);
  return d;
}

/** How far back a slot search looks. Further back than this is treated as no slot. */
export const MAX_LOOKBACK_MS = 8 * 24 * 60 * MINUTE;

/**
 * The latest slot at or before `now`, strictly after `after` (when given), no
 * further back than `MAX_LOOKBACK_MS`. Null when there is none.
 *
 * Minute-by-minute, newest first: at most 11 520 cheap checks for an
 * expression that matches nothing in eight days, and one for an expression
 * matching every minute. Runs once per schedule per 30 s tick.
 */
export function latestSlot(m: CronMatcher, now: Date, after?: Date | null): Date | null {
  const floor = Math.max(now.getTime() - MAX_LOOKBACK_MS, after ? after.getTime() + 1 : -Infinity);
  for (let t = floorMinute(now).getTime(); t >= floor; t -= MINUTE) {
    const d = new Date(t);
    if (matchesMinute(m, d)) return d;
  }
  return null;
}
