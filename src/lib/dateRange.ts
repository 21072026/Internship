/**
 * Reading a `?from=…&to=…` date range off a query string (#1501).
 *
 * THE BUG THIS EXISTS TO END. `new Date('2026-09-23')` is **midnight** — the
 * first instant of that day. Used as an upper bound with `lte`, it excludes
 * everything that happened *during* the day the caller picked. Every screen in
 * this app that offers a date range sends `to` as `YYYY-MM-DD` (the value an
 * `<input type="date">` holds, and what `toISOString().slice(0, 10)` produces),
 * so the default admin analytics view — preset "6m" — silently reported no
 * relations started today, no interactions logged today, no meetings scheduled
 * today. It read as a rendering bug: with a database whose rows were all
 * created today, the trends chart was twelve bars of zero (#1484, and #1501
 * after #1425 had already fixed the layout underneath it).
 *
 * `/api/admin/invitations` had found this independently and fixed it inline;
 * the other five copies of the same three lines had not, which is why the rule
 * now lives here and they all call it.
 *
 * THE RULE. A date-only bound names a DAY, so the range covers that whole day:
 * `from` is its first instant, `to` its last. A bound that carries a time is
 * an instant and is taken literally — a caller that asked for 14:30 means
 * 14:30.
 *
 * Local time, not UTC, because the app's own month bucketing is local
 * (`d.getFullYear()`, `d.getMonth()`) and a range that disagreed with the
 * buckets it fills would be a subtler version of this same bug. On a server
 * running UTC — ours — the two are identical.
 *
 * Dependency-free so it can be unit-tested with `node --test`
 * (scripts/test/date-range.test.mjs).
 */

/** `YYYY-MM-DD` with nothing after it. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parts(value: string): [number, number, number] {
  const [y, m, d] = value.split('-').map(Number);
  return [y, m, d];
}

function valid(date: Date): Date | null {
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The lower bound of a range: the first instant of the named day, or the
 * instant itself. `null` for a missing or unparseable value, so the caller can
 * fall back to its own default rather than 500.
 */
export function rangeStart(value: string | null | undefined): Date | null {
  if (!value) return null;
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = parts(value);
    return valid(new Date(y, m - 1, d, 0, 0, 0, 0));
  }
  return valid(new Date(value));
}

/**
 * The upper bound of a range: the LAST instant of the named day, or the
 * instant itself.
 *
 * `23:59:59.999` rather than the next day's midnight so the bound stays
 * inclusive (`lte`) — with an exclusive bound every caller would have to
 * remember to switch comparison operators, and the ones that compare in JS
 * (`leftAt <= to`) cannot.
 */
export function rangeEnd(value: string | null | undefined): Date | null {
  if (!value) return null;
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = parts(value);
    return valid(new Date(y, m - 1, d, 23, 59, 59, 999));
  }
  return valid(new Date(value));
}
