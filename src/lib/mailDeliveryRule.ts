// Mail delivery rules: lanes, SMTP error classes, backoff, the shared send
// budget's arithmetic and natural de-duplication keys.
//
// WHY THIS EXISTS
//   Every mail this app sends shares ONE relay allowance: a per-client rate the
//   relay enforces with a `450 4.7.1` ("too much mail"), not a polite queue. A
//   cron that fired thirteen reminders in one second got ten through and lost
//   the other three, every day, because a 4xx was treated exactly like a 5xx
//   and nobody retried. And the same allowance carries the password reset a
//   person is waiting for. So delivery needs three things it never had:
//     • a LANE per mail — what may wait, and for how long;
//     • a BUDGET shared by every process of one environment, with a reserve the
//       waiting lanes can never spend;
//     • an honest reading of an SMTP failure — a throttle is about the relay, so
//       it pauses everybody and is not charged to the message; a 4xx about one
//       message is retried; a 5xx is final.
//
// THIS FILE IS PURE
//   No Prisma, no `@/` alias, no I/O. The database half (one row, one
//   conditional UPDATE per token) lives in `mailBudgetStore.ts`; the transport
//   half in `src/services/emailService.ts`. Loaded by
//   `node --test --experimental-strip-types` (scripts/test/mail-delivery-rule.test.mjs).
//   `emailGroups.ts` is client-safe and dependency-free, which is why it is the
//   one import: the lane of a mail is read from the group taxonomy and from
//   nowhere else, so "which mail may wait?" cannot drift from "which mail is
//   automated volume?".
import { createHash } from 'node:crypto';
import { groupForCategory, isBulkGroup, isEssentialGroup, type EmailGroupId } from './emailGroups';

// ── Lanes ────────────────────────────────────────────────────────────────────

/**
 * CRITICAL      — a person is waiting (sign-in, reset, verification, security
 *                 notice, invitation, operator alert). Sent inline, may spend
 *                 the reserve.
 * TRANSACTIONAL — written to or about one person, should arrive within seconds
 *                 to minutes (messages, meeting invites and reminders, lifecycle
 *                 and pipeline mail, inbound requests).
 * BULK          — automated volume that may take hours (digests, task nudges,
 *                 reports, newsletters, announcements, surveys).
 */
export type MailLane = 'CRITICAL' | 'TRANSACTIONAL' | 'BULK';
export const MAIL_LANES: readonly MailLane[] = ['CRITICAL', 'TRANSACTIONAL', 'BULK'];

const LANE_RANK: Record<MailLane, number> = { CRITICAL: 2, TRANSACTIONAL: 1, BULK: 0 };

/**
 * Bulk groups whose mail is still time-bound: a meeting reminder is worthless
 * after the meeting starts, so it rides the transactional lane even though the
 * taxonomy (rightly) puts it on the bulk channel and gives it List-* headers.
 * Which transport carries a mail and how long it may wait are separate
 * questions — the same split `emailService.ts` makes for 'retention-reminder'.
 */
const TIME_BOUND_BULK_GROUPS: ReadonlySet<EmailGroupId> = new Set<EmailGroupId>(['meeting_reminders']);

/** Bulk groups that are published content rather than a nudge about the
 *  reader's own work: they drain last. */
const LOWEST_PRIORITY_GROUPS: ReadonlySet<EmailGroupId> = new Set<EmailGroupId>(['newsletter', 'announcements', 'surveys']);

/**
 * The lane a category belongs to. An unknown or missing category is CRITICAL:
 * the same fail-safe `transportFor()` and the unsubscribe gate use — a taxonomy
 * gap must never make somebody's sign-in mail wait behind a newsletter.
 */
export function laneFor(category?: string | null): MailLane {
  const group = groupForCategory(category);
  if (!group || isEssentialGroup(group)) return 'CRITICAL';
  if (TIME_BOUND_BULK_GROUPS.has(group)) return 'TRANSACTIONAL';
  return isBulkGroup(group) ? 'BULK' : 'TRANSACTIONAL';
}

/**
 * A caller may move a mail to a LOWER lane (a bulk invitation run is not 200
 * people waiting at a sign-in screen), never to a higher one: a lane is a claim
 * on the reserve, and a claim the taxonomy did not grant would let any bulk
 * sender jump the queue.
 */
export function effectiveLane(category?: string | null, requested?: MailLane | null): MailLane {
  const natural = laneFor(category);
  if (!requested || !(requested in LANE_RANK)) return natural;
  return LANE_RANK[requested] < LANE_RANK[natural] ? requested : natural;
}

/** Job priority for a queued mail (higher drains first). */
export function lanePriority(lane: MailLane, category?: string | null): number {
  if (lane === 'CRITICAL') return 100;
  if (lane === 'TRANSACTIONAL') return 50;
  const group = groupForCategory(category);
  return group && LOWEST_PRIORITY_GROUPS.has(group) ? 0 : 20;
}

/** How long a queued mail of this lane stays worth sending (critical mail may
 *  be bounded tighter by its token's own expiry). */
export const LANE_MAX_AGE_MS: Record<MailLane, number> = {
  CRITICAL: 24 * 60 * 60 * 1000,
  TRANSACTIONAL: 12 * 60 * 60 * 1000,
  BULK: 72 * 60 * 60 * 1000,
};

// ── SMTP error classes ───────────────────────────────────────────────────────

/**
 * throttle  — the relay is rate-limiting this client. Relay-wide: pause the
 *             budget, put the mail back, charge the message nothing.
 * relay     — the relay is unreachable or refuses our credentials (connection,
 *             timeout, TLS, DNS, EAUTH). Relay-wide for the same reason: the
 *             next message would fail the same way.
 * retry     — a temporary refusal about THIS message (a 4xx that is not a
 *             throttle). Retried with backoff; counts as an attempt.
 * permanent — a 5xx about this message. Final.
 */
export type SmtpErrorKind = 'throttle' | 'relay' | 'retry' | 'permanent';

export interface SmtpErrorClass {
  kind: SmtpErrorKind;
  /** True for throttle and relay: the failure says nothing about the message. */
  relayWide: boolean;
  /** True for everything except `permanent`. */
  retryable: boolean;
  /** Log-safe label — a code, never the server's text (which can echo an address). */
  reason: string;
}

// nodemailer's own codes for failures that are not about any one message.
const RELAY_CODES = new Set([
  'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS', 'EAUTH', 'ENOAUTH', 'EOAUTH2',
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
]);

// Wording relays use for a rate limit when the enhanced status code is missing.
// Deliberately narrow: "quota exceeded" or "too many recipients" is usually
// about ONE mailbox or ONE message, and reading it as relay-wide would pause
// every lane over a single full inbox.
const RATE_TEXT = /too much mail|too many (?:messages|connections|mails)|rate.?limit|throttl|slow down/i;

export interface SmtpErrorLike {
  code?: unknown;
  responseCode?: unknown;
  response?: unknown;
  message?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The three-digit reply code, from `responseCode` or — for a wrapped error
 *  that lost it — from the leading reply in the message text. */
function replyCodeOf(e: SmtpErrorLike): number | null {
  if (typeof e.responseCode === 'number' && e.responseCode >= 200 && e.responseCode < 600) return e.responseCode;
  const m = `${str(e.response)} ${str(e.message)}`.match(/(?:^|[\s:])([45]\d\d)(?=[\s-]|$)/);
  return m ? Number(m[1]) : null;
}

export function classifySmtpError(err: unknown): SmtpErrorClass {
  const e: SmtpErrorLike = err && typeof err === 'object' ? (err as SmtpErrorLike) : { message: String(err) };
  const code = str(e.code).toUpperCase();
  const text = `${str(e.response)} ${str(e.message)}`;
  const reply = replyCodeOf(e);
  const enhanced = text.match(/\b([245])\.(\d{1,3})\.(\d{1,3})\b/);
  const label = reply ? `smtp_${reply}${enhanced ? `_${enhanced[0]}` : ''}` : code || 'unknown';

  // Credentials first: EAUTH arrives with a 535 and must not read as a 5xx
  // about the message — every message after it would fail the same way.
  if (RELAY_CODES.has(code)) return { kind: 'relay', relayWide: true, retryable: true, reason: code };

  if (reply !== null && reply >= 400 && reply < 500) {
    const policy = enhanced?.[1] === '4' && enhanced[2] === '7';
    if (reply === 421 || (reply >= 450 && reply < 460 && (policy || RATE_TEXT.test(text)))) {
      return { kind: 'throttle', relayWide: true, retryable: true, reason: label };
    }
    return { kind: 'retry', relayWide: false, retryable: true, reason: label };
  }
  if (reply !== null && reply >= 500) return { kind: 'permanent', relayWide: false, retryable: false, reason: label };
  if (RATE_TEXT.test(text)) return { kind: 'throttle', relayWide: true, retryable: true, reason: 'rate_text' };
  // Nothing recognisable (a bug in a builder, an attachment that would not
  // read): retried, bounded by the attempt count and the lane's max age, rather
  // than declared final on evidence that says nothing either way.
  return { kind: 'retry', relayWide: false, retryable: true, reason: label };
}

// ── Backoff (message-specific retries only) ──────────────────────────────────

const BACKOFF: Record<MailLane, { baseMs: number; capMs: number }> = {
  CRITICAL: { baseMs: 15_000, capMs: 5 * 60_000 },
  TRANSACTIONAL: { baseMs: 30_000, capMs: 15 * 60_000 },
  BULK: { baseMs: 2 * 60_000, capMs: 60 * 60_000 },
};

/**
 * Delay before retry number `attempt` (1 = the first retry): exponential,
 * capped per lane, with "equal jitter" — half fixed, half random — so a burst
 * that failed together does not retry together, and no delay is ever zero.
 */
export function retryDelayMs(attempt: number, lane: MailLane, random: () => number = Math.random): number {
  const { baseMs, capMs } = BACKOFF[lane];
  const n = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(n - 1, 20));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(ceiling / 2 + (ceiling / 2) * r);
}

// ── The shared budget (GCRA) ─────────────────────────────────────────────────
//
// One row per environment holds a single instant, the theoretical arrival time
// (`tat`). With an emission interval I = 60s / R and a burst of C, a send is
// allowed when `tat − now ≤ τ`, and moves `tat` to `max(tat, now) + I`. That is
// a token bucket in one column, and spending a token is one conditional UPDATE.
//
// The critical reserve is a smaller tolerance for the other lanes:
//   CRITICAL       τ = (C − 1) · I
//   TRANSACTIONAL  τ = (C − 1 − K) · I
//   BULK           τ = (C − 1 − K) · I
// so the last K tokens of every burst are only ever spent by CRITICAL mail. A
// negative τ (K = C) means the waiting lanes must leave one interval idle
// before they send, which is the reserve when the burst is a single token.
// Worst case in any 60 s window: about R + C − 1 sends.

export type MeterMode = 'off' | 'observe';

export interface BudgetConfig {
  ratePerMin: number;
  burst: number;
  urgentReserve: number;
  intervalMs: number;
  mode: MeterMode;
  /** Pause ladder for a throttle, seconds, escalating. */
  ladderSec: readonly number[];
}

export const DEFAULT_LADDER_SEC: readonly number[] = [60, 120, 300, 900, 1800];

function intEnv(v: string | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function parseLadder(v: string | undefined): readonly number[] {
  if (!v || !v.trim()) return DEFAULT_LADDER_SEC;
  const steps = v
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.min(Math.floor(n), 24 * 60 * 60));
  return steps.length ? steps : DEFAULT_LADDER_SEC;
}

/**
 * The budget from the environment. Conservative when unset (2/min, burst 2,
 * reserve 1); every value is clamped, so a typo slows mail down rather than
 * removing the limit. `MAIL_METER_MODE`: `observe` (default) meters and logs
 * what it would have refused but never refuses; `off` does not touch the
 * meter at all.
 */
export function budgetConfig(env: Record<string, string | undefined>): BudgetConfig {
  const ratePerMin = intEnv(env.MAIL_RATE_PER_MIN, 2, 1, 600);
  const burst = intEnv(env.MAIL_BURST, 2, 1, 100);
  const urgentReserve = Math.min(burst, intEnv(env.MAIL_URGENT_RESERVE, 1, 0, 100));
  const rawMode = (env.MAIL_METER_MODE ?? '').trim().toLowerCase();
  const mode: MeterMode = rawMode === 'off' ? 'off' : 'observe';
  return {
    ratePerMin,
    burst,
    urgentReserve,
    intervalMs: Math.ceil(60_000 / ratePerMin),
    mode,
    ladderSec: parseLadder(env.MAIL_THROTTLE_LADDER_SEC),
  };
}

/** τ for a lane, in milliseconds (may be negative — see above). */
export function laneToleranceMs(lane: MailLane, cfg: BudgetConfig): number {
  const tokens = lane === 'CRITICAL' ? cfg.burst - 1 : cfg.burst - 1 - cfg.urgentReserve;
  return tokens * cfg.intervalMs;
}

export interface GcraDecision {
  allowed: boolean;
  /** The new `tat` when allowed; the unchanged one when refused. */
  tatMs: number;
  /** How long until this lane would be allowed (0 when allowed). */
  waitMs: number;
}

/** The decision the store's conditional UPDATE makes, in memory — the twin the
 *  unit test pins and the store's SQL mirrors. */
export function gcraSpend(tatMs: number, nowMs: number, lane: MailLane, cfg: BudgetConfig): GcraDecision {
  const tolerance = laneToleranceMs(lane, cfg);
  const ahead = tatMs - nowMs;
  if (ahead <= tolerance) return { allowed: true, tatMs: Math.max(tatMs, nowMs) + cfg.intervalMs, waitMs: 0 };
  return { allowed: false, tatMs, waitMs: ahead - tolerance };
}

// ── Throttle pauses ──────────────────────────────────────────────────────────

/** Seconds a throttle at this level pauses the budget for. */
export function pauseSeconds(level: number, ladder: readonly number[] = DEFAULT_LADDER_SEC): number {
  const steps = ladder.length ? ladder : DEFAULT_LADDER_SEC;
  const i = Math.min(Math.max(0, Math.floor(level)), steps.length - 1);
  return steps[i];
}

/** A throttle: push `tat` out by the current rung, then climb one rung. */
export function applyThrottle(
  tatMs: number,
  nowMs: number,
  level: number,
  ladder: readonly number[] = DEFAULT_LADDER_SEC,
): { tatMs: number; level: number } {
  const steps = ladder.length ? ladder : DEFAULT_LADDER_SEC;
  return {
    tatMs: Math.max(tatMs, nowMs + pauseSeconds(level, steps) * 1000),
    level: Math.min(Math.max(0, Math.floor(level)) + 1, steps.length - 1),
  };
}

/** A delivered mail (a 250) walks the ladder one rung back down. */
export function decayPauseLevel(level: number): number {
  return Math.max(0, Math.floor(level) - 1);
}

// ── Identity and de-duplication ──────────────────────────────────────────────

/** sha256 of the normalised address: what a log line or a queued row may carry
 *  instead of the address itself. */
export function recipientHash(to: string): string {
  return createHash('sha256').update(to.trim().toLowerCase()).digest('hex');
}

const ID_PART = /^[A-Za-z0-9_.-]{1,48}$/; // 48: three parts + prefix stay under 191

function part(v: string | number): string {
  const s = String(v);
  if (!ID_PART.test(s)) throw new Error('dedupeKeyFor: a key part must be 1–48 characters of [A-Za-z0-9_.-]');
  return s;
}

/**
 * The natural identity of one logical mail, used as `Job.idempotencyKey` (a
 * global unique, at most 191 characters) so a cron that fires twice, or a
 * request that is retried, never sends twice.
 *
 * `fallback` is for everything without a natural key: a hash of the category,
 * the recipient, the subject and a caller reference — or, without one, the
 * minute it was asked for, so the same mail asked for twice in one minute is
 * one mail, and the same text a day later is a new one.
 */
export type DedupeInput =
  | { kind: 'reset'; tokenId: string }
  | { kind: 'meeting-reminder'; meetingId: string; userId: string }
  | { kind: 'digest'; digest: string; userId: string; day: string }
  | { kind: 'newsletter'; newsletterId: string; recipient: string }
  | { kind: 'ops'; alert: string; at: Date }
  | { kind: 'fallback'; category?: string | null; to: string; subject: string; ref?: string | null; at: Date };

export function dedupeKeyFor(input: DedupeInput): string {
  switch (input.kind) {
    case 'reset':
      return `reset:${part(input.tokenId)}`;
    case 'meeting-reminder':
      return `mrem:${part(input.meetingId)}:${part(input.userId)}`;
    case 'digest':
      return `digest:${part(input.digest)}:${part(input.userId)}:${part(input.day)}`;
    case 'newsletter':
      return `nl:${part(input.newsletterId)}:${recipientHash(input.recipient).slice(0, 32)}`;
    case 'ops':
      return `ops:${part(input.alert)}:${input.at.toISOString().slice(0, 13)}`;
    case 'fallback': {
      const bucket = input.ref ? `ref:${input.ref}` : `min:${input.at.toISOString().slice(0, 16)}`;
      const digest = createHash('sha256')
        .update([input.category ?? '', recipientHash(input.to), input.subject, bucket].join('\n'))
        .digest('hex');
      return `mail:${digest}`;
    }
  }
}
