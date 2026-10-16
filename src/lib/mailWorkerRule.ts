// Mail outbox rules: when a mail goes to the queue, how a queued mail is
// settled, and how its envelope is written and read back.
//
// WHY THIS EXISTS
//   `mailDeliveryRule.ts` says what a failure MEANS (relay-wide, a retry about
//   the message, final). This file says what the outbox DOES about it, so the
//   whole decision table — sent, released, retried, dead, expired — is one pure
//   function the unit test can walk row by row
//   (scripts/test/mail-worker.test.mjs). The database half is
//   `src/lib/mailOutbox.ts`; the transport half `src/services/emailService.ts`.
//
// THIS FILE IS PURE
//   No Prisma, no `@/` alias, no I/O, no secrets. Sealing the envelope needs the
//   server secret, so it happens in `mailOutbox.ts`; this file only turns a
//   prepared mail into the JSON that is sealed, and back.
import { randomUUID } from 'node:crypto';
import {
  LANE_MAX_AGE_MS,
  classifySmtpError,
  pauseSeconds,
  retryDelayMs,
  type BudgetConfig,
  type MailLane,
  type SmtpErrorClass,
} from './mailDeliveryRule';

/** The job name every queued mail carries (`src/lib/jobs/types.ts`). */
export const MAIL_JOB_NAME = 'email.send';

/** `Job.payload.v` — bumped if the payload shape ever changes. */
export const MAIL_PAYLOAD_VERSION = 1;

/** Attempts a queued mail gets before it is dead (relay-wide failures are not
 *  attempts — but see `RELAY_RELEASES_PER_ATTEMPT`). */
export const MAIL_MAX_ATTEMPTS = 5;

/**
 * A relay-wide failure is not the message's fault, so it costs no attempt —
 * but not without limit: every this-many relay-wide releases of the SAME row
 * count as one attempt. A failure that is really about one row and only LOOKS
 * relay-wide (a timeout on one slow message, a relay that answers one
 * recipient with a policy code) could otherwise be released forever, pausing
 * everybody each time; this way it goes dead after
 * `MAIL_MAX_ATTEMPTS × RELAY_RELEASES_PER_ATTEMPT` releases at most. A real
 * outage rotates the releases over the queue (the released row goes behind
 * the rest of its batch), so no single row pays for all of it.
 */
export const RELAY_RELEASES_PER_ATTEMPT = 4;

/**
 * Attachments above this many bytes (in total) are never queued: the envelope
 * would be a multi-megabyte JSON row. Such a mail is sent inline and, on a
 * temporary failure, recorded FAILED as before.
 */
export const MAX_QUEUED_ATTACHMENT_BYTES = 256 * 1024;

/** How long a critical mail may hold the request before it goes to the queue. */
export const DEFAULT_INLINE_TIMEOUT_MS = 5_000;

/**
 * A critical send that outlived its inline cap is still in flight. Its queued
 * copy waits this long before the drain may take it, so the in-flight send has
 * time to finish (and cancel the copy) — the urgent transport gives up after
 * at most 3 s + 3 s + 5 s.
 */
export const INLINE_FALLBACK_DELAY_MS = 30_000;

/** The drain's wall-clock budget per tick (the tick itself is every 5 s). */
export const DRAIN_MAX_MS = 25_000;

/** Rows claimed per round trip of the drain. */
export const DRAIN_BATCH = 5;

// ── Policy from the environment ─────────────────────────────────────────────

export interface MailPolicy {
  /**
   * Lanes whose mail is queued instead of sent inline (`MAIL_QUEUE_LANES`,
   * comma-separated). Empty by default: every mail is sent inline as before,
   * and only a temporary failure reaches the queue. CRITICAL is never listed —
   * a person is waiting for it, so it is always tried inline first.
   */
  queueLanes: ReadonlySet<MailLane>;
  /** `MAIL_INLINE_TIMEOUT_MS`: the inline cap for critical mail (1–30 s). */
  inlineTimeoutMs: number;
  /** `MAIL_WORKER_ENABLED`: `0`/`false`/`off`/`no` switches the drain off. */
  workerEnabled: boolean;
}

const QUEUEABLE_LANES: readonly MailLane[] = ['TRANSACTIONAL', 'BULK'];

export function mailPolicy(env: Record<string, string | undefined>): MailPolicy {
  const lanes = new Set<MailLane>();
  for (const raw of (env.MAIL_QUEUE_LANES ?? '').split(',')) {
    const lane = raw.trim().toUpperCase();
    if ((QUEUEABLE_LANES as readonly string[]).includes(lane)) lanes.add(lane as MailLane);
  }
  const t = Number((env.MAIL_INLINE_TIMEOUT_MS ?? '').trim() || NaN);
  const inlineTimeoutMs = Number.isFinite(t) ? Math.min(30_000, Math.max(1_000, Math.floor(t))) : DEFAULT_INLINE_TIMEOUT_MS;
  const w = (env.MAIL_WORKER_ENABLED ?? '').trim().toLowerCase();
  return { queueLanes: lanes, inlineTimeoutMs, workerEnabled: !['0', 'false', 'off', 'no'].includes(w) };
}

// ── Lifetime ────────────────────────────────────────────────────────────────

/**
 * The moment a queued mail stops being worth sending: the lane's maximum age,
 * or the caller's own deadline (a token's expiry, a meeting's start) when that
 * is earlier. A caller can shorten a mail's life, never extend it.
 */
export function notAfterFor(lane: MailLane, now: Date, explicit?: Date | null): Date {
  const cap = now.getTime() + LANE_MAX_AGE_MS[lane];
  const own = explicit instanceof Date && Number.isFinite(explicit.getTime()) ? explicit.getTime() : Infinity;
  return new Date(Math.min(cap, own));
}

/** True once `notAfter` has passed. A missing or unreadable value never expires
 *  a row by itself: the attempt count still bounds it. */
export function isExpired(notAfter: string | null | undefined, now: Date): boolean {
  if (!notAfter) return false;
  const t = Date.parse(notAfter);
  return Number.isFinite(t) && t <= now.getTime();
}

// ── The breaker ─────────────────────────────────────────────────────────────

export interface BudgetState {
  /** How far the budget's `tat` is ahead of the database clock, ms (the meter). */
  aheadMs: number;
  /** How long the relay pause still runs, ms (`MailBudget.pausedUntil`); ≤ 0
   *  when it is over or there never was one. */
  pausedMs: number;
  /** The throttle ladder's rung (0 = no throttle seen since the last delivery). */
  pauseLevel: number;
}

/**
 * The relay is paused: a throttle or a relay-wide failure set a pause that has
 * not run out yet. A critical mail then goes straight to the queue — an SMTP
 * attempt would only cost the person its timeout — and the drain stops taking
 * rows until the pause ends.
 *
 * Decided on the PAUSE alone (`pausedUntil`), never on `tat`: in observe mode
 * every send is charged to `tat`, so after a burst it can sit hours ahead with
 * no pause at all, and a breaker reading it would hold a password reset past
 * its link's expiry. A budget that is merely busy never opens the breaker —
 * that is the meter's job. When the pause runs out the breaker closes even
 * though the rung is still raised, so the next mail is the probe: delivered, it
 * walks the ladder down; refused, it pauses again one rung higher. `off` mode
 * never opens it.
 */
export function breakerOpen(state: BudgetState | null, cfg: Pick<BudgetConfig, 'mode'>): boolean {
  if (cfg.mode === 'off' || !state) return false;
  return Number.isFinite(state.pausedMs) && state.pausedMs > 0;
}

/** How long a mail waits behind an open breaker (0 when it is closed). */
export function breakerWaitMs(state: BudgetState | null, cfg: Pick<BudgetConfig, 'mode'>): number {
  if (!breakerOpen(state, cfg)) return 0;
  return Math.max(0, Math.round(state!.pausedMs));
}

// ── Inline failure → queue ──────────────────────────────────────────────────

/**
 * When an inline send that failed temporarily may first be retried from the
 * queue: after the first rung of the pause ladder for a relay-wide failure (the
 * budget is paused for at least that long), after the lane's first backoff for
 * a refusal about the message.
 */
export function firstQueuedRunAt(
  cls: SmtpErrorClass,
  lane: MailLane,
  now: Date,
  cfg: Pick<BudgetConfig, 'ladderSec'>,
  random: () => number = Math.random,
): Date {
  const delay = cls.relayWide ? pauseSeconds(0, cfg.ladderSec) * 1000 : retryDelayMs(1, lane, random);
  return new Date(now.getTime() + delay);
}

// ── Settling one queued mail ────────────────────────────────────────────────

/**
 * What the drain writes after one delivery attempt of a queued mail.
 *
 *   sent     → SUCCEEDED, envelope cleared, EmailLog SENT.
 *   release  → PENDING again at `runAt`, `releases` + 1, and the tick stops:
 *              the relay refused the session, so the next row would fail the
 *              same way. `attempts` is unchanged except on every
 *              `RELAY_RELEASES_PER_ATTEMPT`-th release, and a row whose
 *              attempts run out that way is dead instead. EmailLog DEFERRED.
 *   retry    → PENDING at `runAt` (backoff), `attempts` + 1. EmailLog DEFERRED.
 *   dead     → FAILED (a 5xx: final) or DEAD_LETTER (attempts exhausted),
 *              envelope cleared. EmailLog FAILED.
 *   expired  → CANCELLED: the next try would land after `notAfter`. Envelope
 *              cleared. EmailLog FAILED ("expired").
 */
export type SettleAction =
  | { kind: 'sent' }
  | { kind: 'release'; runAt: Date; attempts: number; releases: number; reason: string }
  | { kind: 'retry'; runAt: Date; attempts: number; reason: string }
  | { kind: 'dead'; status: 'FAILED' | 'DEAD_LETTER'; attempts: number; reason: string }
  | { kind: 'expired'; attempts: number; reason: string };

export interface SettleInput {
  /** The thrown error, or null for a 250. */
  error: unknown;
  lane: MailLane;
  /** `Job.attempts` before this attempt. */
  attempts: number;
  /** Relay-wide releases of this row so far (`payload.releases`). */
  releases?: number;
  maxAttempts: number;
  notAfter?: string | null;
  now: Date;
  /** Relay-wide only: when the paused budget lets mail through again. */
  pausedUntil?: Date | null;
  ladderSec: readonly number[];
  random?: () => number;
}

export function settleAction(input: SettleInput): SettleAction {
  if (!input.error) return { kind: 'sent' };
  const cls = classifySmtpError(input.error);
  const now = input.now.getTime();
  const notAfter = input.notAfter ? Date.parse(input.notAfter) : NaN;

  if (cls.relayWide) {
    const floor = now + pauseSeconds(0, input.ladderSec) * 1000;
    const until = input.pausedUntil instanceof Date ? input.pausedUntil.getTime() : NaN;
    const runAt = Number.isFinite(until) ? Math.max(floor, until) : floor;
    // Released, not charged — except every RELAY_RELEASES_PER_ATTEMPT-th time,
    // so a row cannot be released forever. A mail whose life ends before the
    // relay comes back is not kept waiting for nothing.
    const prior = Math.max(0, Math.floor(input.attempts));
    const releases = Math.max(0, Math.floor(input.releases ?? 0)) + 1;
    const attempts = releases % RELAY_RELEASES_PER_ATTEMPT === 0 ? prior + 1 : prior;
    if (attempts > prior && attempts >= Math.max(1, input.maxAttempts)) {
      return { kind: 'dead', status: 'DEAD_LETTER', attempts, reason: `${cls.reason}:releases` };
    }
    if (Number.isFinite(notAfter) && runAt > notAfter) {
      return { kind: 'expired', attempts, reason: `${cls.reason}:expired` };
    }
    return { kind: 'release', runAt: new Date(runAt), attempts, releases, reason: cls.reason };
  }

  const attempts = Math.max(0, Math.floor(input.attempts)) + 1;
  if (!cls.retryable) return { kind: 'dead', status: 'FAILED', attempts, reason: cls.reason };
  if (attempts >= Math.max(1, input.maxAttempts)) {
    return { kind: 'dead', status: 'DEAD_LETTER', attempts, reason: `${cls.reason}:attempts` };
  }
  const runAt = now + retryDelayMs(attempts, input.lane, input.random);
  if (Number.isFinite(notAfter) && runAt > notAfter) {
    return { kind: 'expired', attempts, reason: `${cls.reason}:expired` };
  }
  return { kind: 'retry', runAt: new Date(runAt), attempts, reason: cls.reason };
}

// ── The envelope ────────────────────────────────────────────────────────────
//
// What is sealed into `Job.payload.box`: the prepared mail exactly as
// `deliverPrepared()` takes it. JSON cannot carry a Buffer, so attachments are
// written as base64 and read back as Buffers — the one transformation here.

export interface EnvelopeAttachment {
  filename?: string;
  content: Buffer | string;
  contentType?: string;
  cid?: string;
}

export interface EnvelopeMessage {
  from?: unknown;
  to?: unknown;
  subject?: string;
  html?: unknown;
  text?: unknown;
  replyTo?: unknown;
  headers?: unknown;
  attachments?: EnvelopeAttachment[];
}

export interface Envelope {
  to: string;
  subject: string;
  category?: string;
  transport: 'primary' | 'bulk';
  lane: MailLane;
  group?: string | null;
  userId?: string | null;
  orgId?: string | null;
  world?: string | null;
  message: EnvelopeMessage;
}

export function attachmentBytes(message: EnvelopeMessage): number {
  let n = 0;
  for (const a of message.attachments ?? []) {
    n += typeof a.content === 'string' ? Buffer.byteLength(a.content) : (a.content?.length ?? 0);
  }
  return n;
}

/** May this mail be put on the queue at all? (Attachment size only.) */
export function queueable(envelope: { message: EnvelopeMessage }): boolean {
  return attachmentBytes(envelope.message) <= MAX_QUEUED_ATTACHMENT_BYTES;
}

export function encodeEnvelope(envelope: Envelope): string {
  const { attachments, ...rest } = envelope.message;
  return JSON.stringify({
    ...envelope,
    message: {
      ...rest,
      ...(attachments?.length
        ? {
            attachments: attachments.map((a) => ({
              ...(a.filename !== undefined ? { filename: a.filename } : {}),
              ...(a.contentType !== undefined ? { contentType: a.contentType } : {}),
              ...(a.cid !== undefined ? { cid: a.cid } : {}),
              base64: (typeof a.content === 'string' ? Buffer.from(a.content) : a.content).toString('base64'),
            })),
          }
        : {}),
    },
  });
}

/** The envelope back, or null when the JSON is not one (a corrupt or foreign row). */
export function decodeEnvelope(json: string | null | undefined): Envelope | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const message = e.message as Record<string, unknown> | undefined;
  if (typeof e.to !== 'string' || typeof e.subject !== 'string' || !message || typeof message !== 'object') return null;
  if (e.transport !== 'primary' && e.transport !== 'bulk') return null;
  if (e.lane !== 'CRITICAL' && e.lane !== 'TRANSACTIONAL' && e.lane !== 'BULK') return null;
  const { attachments, ...rest } = message;
  const out: Envelope = {
    ...(e as unknown as Envelope),
    message: {
      ...(rest as EnvelopeMessage),
      ...(Array.isArray(attachments) && attachments.length
        ? {
            attachments: (attachments as Record<string, unknown>[]).map((a) => ({
              ...(typeof a.filename === 'string' ? { filename: a.filename } : {}),
              ...(typeof a.contentType === 'string' ? { contentType: a.contentType } : {}),
              ...(typeof a.cid === 'string' ? { cid: a.cid } : {}),
              content: Buffer.from(typeof a.base64 === 'string' ? a.base64 : '', 'base64'),
            })),
          }
        : {}),
    },
  };
  return out;
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * The `ref` a mail without a natural de-duplication key is keyed by: the minute
 * it was asked for and a random id. Deliberately NOT derived from the mail's
 * content: a body can carry a sign-in or reset token, and a hash of it would sit
 * in the job's idempotency key for no gain. Two calls are therefore always two
 * mails; a sender that must not send twice passes a natural key
 * (`dedupeKeyFor()`), which the one call reuses across its inline attempt and
 * its queued retry.
 */
export function fallbackRef(now: Date): string {
  return `${now.toISOString().slice(0, 16)}:${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
