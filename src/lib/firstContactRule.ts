// First contact and trial-date coverage — the two go-live week numbers (#2578,
// docs/marketing-vertical/go-live-checklist.md §2 and §3).
//
// ZERO imports, so the arithmetic is unit-tested without Next or a database
// (scripts/test/first-contact-rule.test.mjs). The Prisma half — reading the
// rows inside the caller's tenant — is src/lib/goLiveMetrics.ts.
//
// ── FIRST CONTACT ─────────────────────────────────────────────────────────────
//
//   The definition, word for word the line in go-live-checklist.md §2 (the unit
//   test reads that file and fails if the two differ):
//
//     First contact: from the demo request's createdAt (the record's startDate
//     when there was no request) to the record's first InteractionLog; DIRECT
//     and group messages do not count.
//
//   The request is the CompanyInquiry converted into the record's account.
//
//   DELIBERATELY NOT "last contact" (src/lib/lastContactRule.ts, #2275). That
//   rule also counts a DIRECT message and the lead's own group message, because
//   it answers "has anyone been in touch lately?". This one answers "how long did
//   the lead wait for us?", and its definition is the checklist's own: a logged
//   interaction (meeting, e-mail, phone — the BCC capture writes one too). DIRECT
//   and group messages do not stop the clock here, and this file does not import
//   the last-contact rule so the two can never drift into one.
//
//   Which records: the ones whose clock STARTED inside the window. A record not
//   contacted yet is `waiting` — counted, never folded into the median as zero or
//   as "now", the same censoring the time-to-hire report applies. A first
//   interaction dated BEFORE the start (a lead somebody already spoke to before
//   they filled in the form) is not a response time and is left out of the
//   median; it is counted as `contactedBefore` so the gap is visible.
//
// ── TRIAL-DATE COVERAGE ──────────────────────────────────────────────────────
//
//   Of the records currently on TRIAL_ACTIVE, the share whose `trialEndsAt` is
//   set. With a window: the ones whose trial started inside it (`trialStartedAt`,
//   else `startDate` — an imported trial with no start stamp is exactly the row
//   most likely to lack an end date, so it must not fall out of the count).
//
// Both results are counts and one rate — no person, no record id.

/** The definition, verbatim — also in docs/marketing-vertical/go-live-checklist.md §2. */
export const FIRST_CONTACT_DEFINITION =
  "First contact: from the demo request's createdAt (the record's startDate when there was no request) to the record's first InteractionLog; DIRECT and group messages do not count.";

const HOUR_MS = 60 * 60 * 1000;

type Instant = Date | number | string;

function ms(value: Instant | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

export interface Window {
  from: Instant | null;
  to: Instant | null;
}

function inWindow(t: number, window?: Window | null): boolean {
  const from = ms(window?.from ?? null);
  const to = ms(window?.to ?? null);
  if (from != null && t < from) return false;
  if (to != null && t > to) return false;
  return true;
}

/** The median of a list of numbers (mean of the two middle values when even), null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface FirstContactRecord {
  /** The demo request's createdAt, when the record came from one. */
  requestedAt?: Instant | null;
  /** The record's own start — the clock's start when there was no request. */
  startDate: Instant;
  /** The record's first InteractionLog, null when there is none yet. */
  firstInteractionAt?: Instant | null;
}

/** Where a record's first-contact clock starts: the request, else the record. */
export function firstContactStart(record: FirstContactRecord): number | null {
  return ms(record.requestedAt ?? null) ?? ms(record.startDate);
}

export interface FirstContactSummary {
  /** Median hours from request to first InteractionLog, one decimal; null when nobody was contacted. */
  medianHours: number | null;
  /** Records in the window that have a first contact (the median's population). */
  contacted: number;
  /** Records in the window with no InteractionLog yet. */
  waiting: number;
  /** Records whose first interaction predates the start — not a response time. */
  contactedBefore: number;
}

export function firstContactSummary(records: readonly FirstContactRecord[], window?: Window | null): FirstContactSummary {
  const hours: number[] = [];
  let waiting = 0;
  let contactedBefore = 0;
  for (const record of records) {
    const start = firstContactStart(record);
    if (start == null || !inWindow(start, window)) continue;
    const contact = ms(record.firstInteractionAt ?? null);
    if (contact == null) {
      waiting++;
      continue;
    }
    if (contact < start) {
      contactedBefore++;
      continue;
    }
    hours.push((contact - start) / HOUR_MS);
  }
  const m = median(hours);
  return {
    medianHours: m == null ? null : Math.round(m * 10) / 10,
    contacted: hours.length,
    waiting,
    contactedBefore,
  };
}

export interface TrialRecord {
  trialStartedAt?: Instant | null;
  startDate: Instant;
  trialEndsAt?: Instant | null;
}

export interface TrialEndCoverage {
  /** TRIAL_ACTIVE records in scope. */
  total: number;
  /** …of which `trialEndsAt` is set. */
  withEnd: number;
  /** withEnd ÷ total as a whole percent; null when there is no trial at all. */
  rate: number | null;
}

/** Coverage over records ALREADY known to sit on TRIAL_ACTIVE (the caller filters the stage). */
export function trialEndCoverage(records: readonly TrialRecord[], window?: Window | null): TrialEndCoverage {
  let total = 0;
  let withEnd = 0;
  for (const record of records) {
    const started = ms(record.trialStartedAt ?? null) ?? ms(record.startDate);
    if (started == null || !inWindow(started, window)) continue;
    total++;
    if (ms(record.trialEndsAt ?? null) != null) withEnd++;
  }
  return { total, withEnd, rate: total === 0 ? null : Math.round((withEnd / total) * 100) };
}
