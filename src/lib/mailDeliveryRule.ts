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
// Dependency-free like emailGroups: the two generated-address domains.
import { ERASED_EMAIL_DOMAIN, PLACEHOLDER_EMAIL_DOMAIN } from './menteeAccount';

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

/**
 * The highest priority a BULK row is ever given. Every other lane sits at or
 * above `HIGHER_LANE_MIN_PRIORITY`, so the drain can claim "everything that is
 * not bulk" and "bulk only" by priority band alone (#2951).
 */
export const BULK_PRIORITY_MAX = 20;
export const HIGHER_LANE_MIN_PRIORITY = 50;

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
 *             timeout, TLS, DNS, EAUTH), or refuses the session before any
 *             message (any reply at the greeting, EHLO, STARTTLS, AUTH or MAIL
 *             FROM). Relay-wide for the same reason: the next message would
 *             fail the same way.
 * retry     — a temporary refusal about THIS message (a 4xx that is not a
 *             throttle). Retried with backoff; counts as an attempt.
 * permanent — a 5xx about this message, or a message nodemailer itself
 *             refuses (too large, no valid recipient). Final.
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
  /** nodemailer's name for the SMTP step that failed: 'CONN', 'EHLO',
   *  'STARTTLS', 'AUTH PLAIN', 'MAIL FROM', 'RCPT TO', 'DATA', 'API'… */
  command?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Failures nodemailer raises itself before the relay said anything about the
// message: an oversized message, an envelope with no or malformed recipients, a
// REQUIRETLS the connection cannot honour. Sending the same message again can
// never succeed, so they are final — but only WITHOUT a reply code: the same
// codes also wrap the relay's own answers to RCPT TO and DATA, read below.
const LOCAL_PERMANENT_CODES = new Set(['EMESSAGE', 'EENVELOPE', 'EREQUIRETLS']);

/**
 * SMTP steps that come before anything about one message: the connection and
 * greeting, EHLO/HELO/LHLO, STARTTLS, AUTH, RSET and our own MAIL FROM (the
 * sender is the account's, the same for every mail). A refusal there — even a
 * 5xx, such as `554 5.7.1` at the greeting for a blocked IP, or `553` for a
 * sender the account may not use — fails every message the same way, so it is
 * about the relay: pause and keep the queue, never drop it message by message.
 */
function isSessionStage(command: string): boolean {
  return (
    command === 'CONN' ||
    command === 'EHLO' ||
    command === 'HELO' ||
    command === 'LHLO' ||
    command === 'STARTTLS' ||
    command === 'RSET' ||
    command === 'MAIL FROM' ||
    command.startsWith('AUTH')
  );
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
  const command = str(e.command).trim().toUpperCase();
  const text = `${str(e.response)} ${str(e.message)}`;
  const reply = replyCodeOf(e);
  const enhanced = text.match(/\b([245])\.(\d{1,3})\.(\d{1,3})\b/);
  const label = reply ? `smtp_${reply}${enhanced ? `_${enhanced[0]}` : ''}` : code || 'unknown';

  // Credentials first: EAUTH arrives with a 535 and must not read as a 5xx
  // about the message — every message after it would fail the same way.
  if (RELAY_CODES.has(code)) return { kind: 'relay', relayWide: true, retryable: true, reason: code };

  // Raised locally, with no reply from the relay: this message can never go.
  if (LOCAL_PERMANENT_CODES.has(code) && typeof e.responseCode !== 'number') {
    return { kind: 'permanent', relayWide: false, retryable: false, reason: code };
  }

  const fourxx = reply !== null && reply >= 400 && reply < 500;
  if (fourxx) {
    // A 4.7.x policy code reads as relay-wide — except at RCPT TO and DATA,
    // where the relay is answering about ONE recipient or ONE message (a
    // greylisted or policy-refused mailbox). There only a 421 or rate wording
    // is about the relay; the rest is a retry of that message, so one
    // recipient's refusal cannot pause every lane (#2944).
    const perMessage = command === 'RCPT TO' || command === 'DATA';
    const policy = enhanced?.[1] === '4' && enhanced[2] === '7' && !perMessage;
    if (reply === 421 || (reply >= 450 && reply < 460 && (policy || RATE_TEXT.test(text)))) {
      return { kind: 'throttle', relayWide: true, retryable: true, reason: label };
    }
  }
  // Any refusal before the message (greeting, EHLO, STARTTLS, AUTH, MAIL FROM)
  // is about the session, whatever its reply code — see isSessionStage().
  if (isSessionStage(command)) {
    return { kind: 'relay', relayWide: true, retryable: true, reason: `${label}@${command.replace(/\s+/g, '_')}` };
  }
  if (fourxx) return { kind: 'retry', relayWide: false, retryable: true, reason: label };
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
// One row per environment and SMTP channel holds a single instant, the theoretical arrival time
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

/**
 * off     — the meter is not touched at all.
 * observe — every send is metered and a refusal is only logged (`would_refuse`).
 * enforce — the queue drain (src/lib/mailOutbox.ts) waits for a token before it
 *           sends a queued mail; inline sends are still only observed.
 */
export type MeterMode = 'off' | 'observe' | 'enforce';

/** The two outbound SMTP channels (`transportFor()` in emailService.ts). */
export type MailChannel = 'primary' | 'bulk';

/**
 * The `MailBudget` row a channel spends from. Each SMTP server meters its own
 * client, so each channel has its own row: a newsletter run on the bulk server
 * must not make the primary relay's password resets look throttled, and a bulk
 * server outage must not pause the primary relay. The primary row keeps the
 * plain name.
 */
export function budgetNameFor(channel: MailChannel): string {
  return channel === 'bulk' ? 'smtp:bulk' : 'smtp';
}

export interface BudgetConfig {
  ratePerMin: number;
  burst: number;
  urgentReserve: number;
  intervalMs: number;
  mode: MeterMode;
  /** Pause ladder for a throttle, seconds, escalating. */
  ladderSec: readonly number[];
  /**
   * `MAIL_DAILY_CAP`: mails per UTC day this environment's channel should
   * carry; 0 (the default, unset) = no cap. BULK stops at
   * `BULK_DAILY_SHARE` of it — the rest is kept for the higher lanes, which
   * the cap never stops (a counter must not hold a password reset).
   */
  dailyCap: number;
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
 * what it would have refused but never refuses; `enforce` makes the queue drain
 * wait for a token (inline sends stay observed); `off` does not touch the
 * meter at all.
 *
 * `channel`: the optional bulk server (`SMTP_BULK_HOST`, #1203) is a different
 * server with its own allowance, so it has its own budget row
 * (`budgetNameFor`) and may have its own numbers — `MAIL_BULK_RATE_PER_MIN`,
 * `MAIL_BULK_BURST`, `MAIL_BULK_URGENT_RESERVE`, each falling back to the
 * primary value. The mode and the throttle ladder are shared.
 */
export function budgetConfig(env: Record<string, string | undefined>, channel: MailChannel = 'primary'): BudgetConfig {
  const pick = (name: string): string | undefined => {
    if (channel === 'bulk') {
      const own = env[`MAIL_BULK_${name}`];
      if (own !== undefined && own.trim() !== '') return own;
    }
    return env[`MAIL_${name}`];
  };
  const ratePerMin = intEnv(pick('RATE_PER_MIN'), 2, 1, 600);
  const burst = intEnv(pick('BURST'), 2, 1, 100);
  const urgentReserve = Math.min(burst, intEnv(pick('URGENT_RESERVE'), 1, 0, 100));
  const rawMode = (env.MAIL_METER_MODE ?? '').trim().toLowerCase();
  const mode: MeterMode = rawMode === 'off' ? 'off' : rawMode === 'enforce' ? 'enforce' : 'observe';
  return {
    ratePerMin,
    burst,
    urgentReserve,
    intervalMs: Math.ceil(60_000 / ratePerMin),
    mode,
    ladderSec: parseLadder(env.MAIL_THROTTLE_LADDER_SEC),
    dailyCap: intEnv(pick('DAILY_CAP'), 0, 0, 10_000_000),
  };
}

// ── The daily cap (#2951) ────────────────────────────────────────────────────
//
// One counter per budget row (`MailBudget.dayKey` + `dayCount`), against the
// DATABASE's UTC day: every metered send of the channel counts, whatever its
// lane, so the number is what the relay saw today. BULK may only spend while
// the count is below 90 % of the cap; the last 10 % is the higher lanes'.
// TRANSACTIONAL and CRITICAL are counted but never refused by it.

/** The share of `MAIL_DAILY_CAP` bulk mail may use. */
export const BULK_DAILY_SHARE = 0.9;

/** How many sends today still let a BULK mail through: floor(90 % of the
 *  cap), at least 1 for any cap; null when there is no cap. */
export function bulkDailyLimit(cfg: Pick<BudgetConfig, 'dailyCap'>): number | null {
  if (!cfg.dailyCap || cfg.dailyCap <= 0) return null;
  return Math.max(1, Math.floor(cfg.dailyCap * BULK_DAILY_SHARE));
}

/** The UTC day a counter belongs to: 'YYYY-MM-DD'. */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Milliseconds until the next UTC midnight (never 0). */
export function msUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, next - now.getTime());
}

/**
 * May a mail of this lane be counted against today's cap? The in-memory twin
 * of the conditional UPDATE in `mailBudgetStore.ts`: a stored count from
 * another day reads as zero; only BULK is ever refused.
 */
export function dailyCapAllows(
  lane: MailLane,
  counter: { dayKey: string | null; dayCount: number },
  today: string,
  cfg: Pick<BudgetConfig, 'dailyCap'>,
): boolean {
  if (lane !== 'BULK') return true;
  const limit = bulkDailyLimit(cfg);
  if (limit === null) return true;
  const used = counter.dayKey === today ? counter.dayCount : 0;
  return used < limit;
}

/** The counter after one more send today. */
export function countSend(counter: { dayKey: string | null; dayCount: number }, today: string): { dayKey: string; dayCount: number } {
  return { dayKey: today, dayCount: counter.dayKey === today ? counter.dayCount + 1 : 1 };
}

// ── What an admin is told about a large send (#2951) ────────────────────────

/** How fast the drain moves mail when nothing paces it (observe or off mode):
 *  a deliberately rough figure for the estimate below, not a limit. */
export const UNPACED_SENDS_PER_MIN = 30;

/**
 * Rough minutes until `backlog` queued mails have left, at the configured
 * rate in enforce mode (or an unpaced drain's rough speed otherwise). At least
 * 1 for any backlog, 0 for none. An estimate shown to a person — "delivered
 * over about 2 h" — never a promise: a relay pause or the daily cap can make
 * it longer, a quiet queue shorter.
 */
export function queueEtaMinutes(
  backlog: number,
  cfg: Pick<BudgetConfig, 'mode' | 'ratePerMin'> & Partial<Pick<BudgetConfig, 'burst' | 'urgentReserve'>>,
): number {
  const n = Math.max(0, Math.floor(backlog));
  if (n === 0) return 0;
  const rate = cfg.mode === 'enforce' ? effectiveLaneRatePerMin(cfg) : UNPACED_SENDS_PER_MIN;
  return Math.max(1, Math.ceil(n / rate));
}

/**
 * The sustained sends per minute a non-critical lane really gets under enforce
 * mode. A reserve that swallows the whole burst (BURST 1 with RESERVE 1) makes
 * the lane's τ negative: each send then waits one extra interval after the
 * previous one, which halves the configured rate — the estimate must say so.
 */
export function effectiveLaneRatePerMin(
  cfg: Pick<BudgetConfig, 'ratePerMin'> & Partial<Pick<BudgetConfig, 'burst' | 'urgentReserve'>>,
): number {
  const rate = Math.max(1, cfg.ratePerMin);
  const burst = cfg.burst ?? 2;
  const reserve = Math.min(burst, cfg.urgentReserve ?? 0);
  const deficit = Math.max(0, -(burst - 1 - reserve));
  return rate / (1 + deficit);
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

// ── Fair sharing between the two worlds (#2951) ─────────────────────────────

/** The products one deployment serves (`docs/worlds.md`). */
export const MAIL_WORLDS = ['INTERNSHIP', 'MARKETING'] as const;
export type MailWorld = (typeof MAIL_WORLDS)[number];

/**
 * The order the drain asks for BULK rows in, given the world of the bulk row
 * it sent last: the OTHER world first, then that one again. So a long
 * campaign in one product cannot starve the other product's digests — each
 * world gets every second bulk slot while both have mail waiting, and either
 * gets all of them when the other has none. (A row with no world, and every
 * row once both preferred claims come back empty, is taken by the fallback
 * claim that names no world.)
 */
export function bulkWorldOrder(last: string | null | undefined): MailWorld[] {
  return last === 'INTERNSHIP' ? ['MARKETING', 'INTERNSHIP'] : ['INTERNSHIP', 'MARKETING'];
}

// ── Addresses nobody reads (#2970) ──────────────────────────────────────────
//
// Some recipients are generated, not typed: a lead the importer, an account
// event or a mentor created without a known address gets a STAND-IN on
// `import.local` (`leadStandInEmail()`, src/lib/menteeAccount.ts), and an
// erased account is rewritten to `erased.local`. Neither is a mailbox. Mail to
// one can only bounce — or, worse, become a draft an operator could approve —
// so `prepareEmail()` refuses it before anything else: recorded SKIPPED with
// the reason below, never queued, never held, whatever the org's settings.

export type UnmailableReason = 'placeholder_address' | 'erased_address';

// A Map, not an object literal: a domain is input, and `constructor` must not
// find Object.prototype.
const UNMAILABLE_DOMAINS: ReadonlyMap<string, UnmailableReason> = new Map([
  [PLACEHOLDER_EMAIL_DOMAIN, 'placeholder_address'],
  [ERASED_EMAIL_DOMAIN, 'erased_address'],
]);

/** The domain of one address, lower-cased; `Name <a@b>` and stray spaces allowed. */
function addressDomain(address: string): string {
  const angled = address.match(/<([^>]*)>/);
  const bare = (angled ? angled[1] : address).trim().toLowerCase();
  const at = bare.lastIndexOf('@');
  return at >= 0 ? bare.slice(at + 1).replace(/\.+$/, '') : '';
}

/**
 * Why this recipient can never be mailed, or null when it can. A list (`a, b`)
 * is refused when ANY address on it is generated: a mail is one decision, and
 * half of it reaching a stand-in is still mail to nobody on a lead's record.
 */
export function unmailableRecipient(to: string | null | undefined): UnmailableReason | null {
  if (typeof to !== 'string') return null;
  for (const one of to.split(',')) {
    const reason = UNMAILABLE_DOMAINS.get(addressDomain(one));
    if (reason) return reason;
  }
  return null;
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
  // `at`: the meeting's start. A moved meeting is reminded again for its new
  // time, so the start is part of the key when given (#2951).
  // `lead` (#1636): minutes ahead; omitted or 60 keeps the pre-#1636 key.
  | { kind: 'meeting-reminder'; meetingId: string; userId: string; at?: Date; lead?: number }
  | { kind: 'guest-reminder'; meetingId: string; guest: string; at?: Date; lead?: number }
  | { kind: 'series-reminder'; seriesId: string; userId: string; at: Date; lead: string }
  | { kind: 'survey'; invitationId: string; round: number }
  | { kind: 'digest'; digest: string; userId: string; day: string }
  | { kind: 'newsletter'; newsletterId: string; recipient: string }
  | { kind: 'ops'; alert: string; at: Date }
  | { kind: 'fallback'; category?: string | null; to: string; subject: string; ref?: string | null; at: Date };

/**
 * The start of the `hours`-long UTC window `now` falls in — what an operator
 * alert's `ops:<kind>:<hour>` key is stamped with, so one alert of a kind per
 * window leaves, across every replica and restart (#2951). `hours` is clamped
 * to 1…24 and should divide 24.
 */
export function opsAlertWindow(now: Date, hours = 1): Date {
  const h = Math.min(24, Math.max(1, Math.floor(hours)));
  const size = h * 60 * 60 * 1000;
  return new Date(Math.floor(now.getTime() / size) * size);
}

/** A Date as whole minutes since the epoch: a key part with no ':' in it. */
function minuteOf(at: Date): string {
  const t = at.getTime();
  if (!Number.isFinite(t)) throw new Error('dedupeKeyFor: an invalid date');
  return String(Math.floor(t / 60_000));
}

// A second lead for the same start time is a second mail (#1636). The hour-before
// lead keeps the key it always had, so no queued reminder is re-sent on deploy.
function leadSuffix(lead: number | undefined): string {
  return lead === undefined || lead === 60 ? '' : `:L${Math.floor(lead)}`;
}

export function dedupeKeyFor(input: DedupeInput): string {
  switch (input.kind) {
    case 'reset':
      return `reset:${part(input.tokenId)}`;
    case 'meeting-reminder':
      return `mrem:${part(input.meetingId)}:${part(input.userId)}${input.at ? `:${minuteOf(input.at)}` : ''}${leadSuffix(input.lead)}`;
    case 'guest-reminder':
      return `mgrem:${part(input.meetingId)}:${recipientHash(input.guest).slice(0, 32)}${input.at ? `:${minuteOf(input.at)}` : ''}${leadSuffix(input.lead)}`;
    case 'series-reminder':
      return `srem:${part(input.seriesId)}:${part(input.userId)}:${minuteOf(input.at)}:${part(input.lead)}`;
    case 'survey':
      return `survey:${part(input.invitationId)}:${part(Math.max(0, Math.floor(input.round)))}`;
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

// ── Primary → bulk failover (#1690) ─────────────────────────────────────────
//
// A queued mail that must reach a person (the CRITICAL and TRANSACTIONAL
// lanes) and keeps failing on the primary relay is tried on the bulk relay
// instead, once the primary has had `MAIL_FAILOVER_AFTER` goes at it — failed
// attempts plus relay-wide releases, both monotonic on the row, so a mail that
// has failed over stays failed over. ONE WAY ONLY: a mail of the bulk channel
// never borrows the primary relay's quota or reputation, and a BULK-lane mail
// that rides the primary (no bulk relay configured) has nowhere to go.
// The From identity moves with it (the bulk relay signs for its own domain,
// `SMTP_BULK_FROM`), which is the caller's job — `failoverEnvelope()` in
// emailService.ts.

export const DEFAULT_FAILOVER_AFTER = 3;

/** `MAIL_FAILOVER_AFTER`: goes on the primary before a failover; 0 turns it off. */
export function failoverAfter(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MAIL_FAILOVER_AFTER;
  if (raw === undefined || raw.trim() === '') return DEFAULT_FAILOVER_AFTER;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_FAILOVER_AFTER;
}

export function failoverDue(facts: {
  transport: MailChannel;
  lane: MailLane;
  attempts: number;
  releases: number;
  after: number;
  bulkAvailable: boolean;
}): boolean {
  if (facts.transport !== 'primary' || facts.lane === 'BULK' || !facts.bulkAvailable || facts.after <= 0) return false;
  const goes = Math.max(0, Math.floor(facts.attempts)) + Math.max(0, Math.floor(facts.releases));
  return goes >= facts.after;
}
