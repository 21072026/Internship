// When a meeting reminder fires (#1636) — the rule, pure and client-safe.
//
// A LEAD is "minutes before the start". Which leads apply:
//
//   1. the meeting's own `Meeting.reminderLeadMinutes` — 0 = no reminder at
//      all, N = exactly one reminder N minutes ahead;
//   2. else the programme → org → global setting `meetingReminderLeadsMinutes`
//      (a short list, e.g. "1440,60");
//   3. else — nothing configured — the leads the product always had: ONE
//      reminder an hour before a one-off meeting, a day-before and an
//      hour-before reminder for a recurring series. So an installation that
//      configures nothing reminds exactly as before.
//
// This decides WHEN someone is reminded, never WHETHER they can be: the
// recipient's `meetingReminders` opt-out is applied by the sender as before.
//
// WHICH LEAD IS DUE (`dueLead`). The cron ticks every 15 minutes, so a lead is
// a window, not an instant:
//   · the SMALLEST lead is due whenever the meeting is that close or closer
//     (a meeting booked 10 minutes ahead still gets its "soon" reminder);
//   · any larger lead L is due while the meeting is within an hour of L on
//     either side, and only while it is further away than the next smaller
//     lead — a meeting booked five hours ahead never gets a late "tomorrow".
// With the legacy leads that is exactly the old `leadFor()`: HOUR_BEFORE at
// ≤ 60 minutes, DAY_BEFORE from 23 hours on (within the 25-hour lookahead).

export const MAX_LEAD_MINUTES = 2880; // two days
export const MAX_LEADS = 4;
/** A larger lead may fire up to this long before or after its nominal time. */
export const LEAD_SLACK_MINUTES = 60;

export const LEGACY_MEETING_LEADS: readonly number[] = [60];
export const LEGACY_SERIES_LEADS: readonly number[] = [1440, 60];

/** The per-meeting choices offered in the meeting form (0 = none). */
export const MEETING_LEAD_CHOICES: readonly number[] = [1440, 60, 30, 0];

/**
 * Parse a stored lead list ("1440, 60"). Empty or unreadable → null ("not
 * configured", the legacy leads apply). Values outside 1…MAX_LEAD_MINUTES are
 * dropped; duplicates removed; at most MAX_LEADS, largest first.
 */
export function parseLeadList(raw: string | null | undefined): number[] | null {
  const values = String(raw ?? '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_LEAD_MINUTES);
  const unique = [...new Set(values)].sort((a, b) => b - a).slice(0, MAX_LEADS);
  return unique.length ? unique : null;
}

/** True when `raw` is a list `parseLeadList` would keep whole (for write-time validation). */
export function isValidLeadList(raw: string): boolean {
  if (raw.trim() === '') return true;
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  if (parts.length > MAX_LEADS) return false;
  return parts.every((p) => /^\d{1,4}$/.test(p) && Number(p) >= 1 && Number(p) <= MAX_LEAD_MINUTES);
}

/** The leads that apply to one meeting or series, largest first. Empty = no reminder. */
export function leadsFor(opts: { override?: number | null; configured: number[] | null; legacy: readonly number[] }): number[] {
  if (opts.override != null) return opts.override > 0 ? [Math.min(opts.override, MAX_LEAD_MINUTES)] : [];
  return [...(opts.configured ?? opts.legacy)].sort((a, b) => b - a);
}

/**
 * The lead to send now for an occurrence `minutesAway` minutes ahead, or null.
 * `sent` holds the leads already sent for it.
 */
export function dueLead(minutesAway: number, leads: readonly number[], sent: ReadonlySet<number> = new Set()): number | null {
  const sorted = [...leads].sort((a, b) => b - a);
  for (let i = 0; i < sorted.length; i++) {
    const lead = sorted[i];
    const smaller = sorted[i + 1];
    const smallest = smaller === undefined;
    const inWindow = smallest
      ? minutesAway <= lead
      : minutesAway <= lead + LEAD_SLACK_MINUTES && minutesAway >= lead - LEAD_SLACK_MINUTES && minutesAway > smaller;
    if (inWindow && !sent.has(lead)) return lead;
  }
  return null;
}

/** How far ahead the reminder sweep must look for these leads. */
export function lookaheadMinutes(leads: readonly number[]): number {
  return Math.max(0, ...leads) + LEAD_SLACK_MINUTES;
}

/** `Meeting.remindedLeads` ("1440,60") ↔ a set. */
export function readRemindedLeads(raw: string | null | undefined): Set<number> {
  return new Set(String(raw ?? '').split(',').filter(Boolean).map(Number).filter(Number.isFinite));
}
export function writeRemindedLeads(leads: ReadonlySet<number>): string {
  return [...leads].sort((a, b) => b - a).join(',');
}

/** The legacy enum a lead maps to, so rows written now still collide with pre-#1636 rows. */
export function legacyLeadEnum(lead: number): 'DAY_BEFORE' | 'HOUR_BEFORE' | null {
  if (lead === 1440) return 'DAY_BEFORE';
  if (lead === 60) return 'HOUR_BEFORE';
  return null;
}

/** A series reminder reads "tomorrow" from half a day ahead, "soon" closer in. */
export function isDayAheadLead(lead: number): boolean {
  return lead >= 12 * 60;
}
