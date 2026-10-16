// Mail queue operations (#2953): the rules behind the health endpoint's `mail`
// block, the admin Queue tab's actions and the three operator alerts. Pure —
// no Prisma, no nodemailer — so `scripts/test/mail-ops.test.mjs` pins them
// without a database; `src/lib/mailQueueAdmin.ts` and `src/lib/mailOpsAlert.ts`
// are the halves that read and write rows.
//
// PII RULE. Nothing here sees an address, a subject or a relay's text: a queued
// mail is a lane, a category, a world, a state, a count of attempts, a reason
// CODE and the sha256 of its recipient — and only a prefix of that hash ever
// leaves the server.

import type { MailLane } from './mailDeliveryRule';

// ── Alerts ───────────────────────────────────────────────────────────────────

/** A critical mail (a sign-in link, a reset) waiting longer than this has a
 *  person waiting at a screen for it. Well past the inline-timeout copy's own
 *  30 s hold, so the normal fallback never alerts. */
export const CRITICAL_PENDING_ALERT_MS = 5 * 60 * 1000;

/** A relay that has refused every session for this long is an outage, not a
 *  throttle: the first three rungs of the default ladder (1 + 2 + 5 min) clear
 *  before it, the fourth (15 min) does not. */
export const BREAKER_OPEN_ALERT_MS = 15 * 60 * 1000;

export type MailOpsAlertKind = 'mail-critical-waiting' | 'mail-breaker-open' | 'mail-relay-auth';

export interface MailOpsFacts {
  now: Date;
  /** When the oldest CRITICAL mail still PENDING was queued; null when none. */
  oldestCriticalQueuedAt: Date | null;
  /** Per channel: is a pause running, and since when has the relay refused. */
  breakers: { channel: string; paused: boolean; outageMs: number | null }[];
  /** The relay rejected our credentials since the last evaluation. */
  authRejected: boolean;
}

/**
 * Which alerts are due. Each kind is raised at most once per hour by its
 * de-duplication key (`ops:<kind>:<hour>`); this only says whether the
 * condition holds now.
 */
export function mailOpsAlertsDue(f: MailOpsFacts): MailOpsAlertKind[] {
  const due: MailOpsAlertKind[] = [];
  if (f.oldestCriticalQueuedAt && f.now.getTime() - f.oldestCriticalQueuedAt.getTime() > CRITICAL_PENDING_ALERT_MS) {
    due.push('mail-critical-waiting');
  }
  if (f.breakers.some((b) => b.paused && b.outageMs !== null && b.outageMs > BREAKER_OPEN_ALERT_MS)) {
    due.push('mail-breaker-open');
  }
  if (f.authRejected) due.push('mail-relay-auth');
  return due;
}

/**
 * Is this failure the relay rejecting our credentials? nodemailer raises
 * `EAUTH` for a refused AUTH (535) and `ENOAUTH` when it has none to offer;
 * `classifySmtpError()` names both by their code. A 5xx at the AUTH step that
 * arrived without nodemailer's code carries `@AUTH` in its reason.
 */
export function isAuthRejection(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason === 'EAUTH' || reason === 'ENOAUTH' || /@AUTH(?:_|$)/.test(reason);
}

// ── Lanes as an operator reads them ─────────────────────────────────────────

const LANES: readonly MailLane[] = ['CRITICAL', 'TRANSACTIONAL', 'BULK'];

/** A queued row's lane, from its payload; an unknown value reads as CRITICAL,
 *  the lane an unknown category goes to (`laneFor()`). */
export function laneOfPayload(payload: unknown): MailLane {
  const lane = payload && typeof payload === 'object' ? (payload as { lane?: unknown }).lane : null;
  return LANES.includes(lane as MailLane) ? (lane as MailLane) : 'CRITICAL';
}

/**
 * A row's lane from its priority — the bands `lanePriority()` writes (CRITICAL
 * 100, TRANSACTIONAL 50, BULK 0–20) and the drain claims by. Lets the counters
 * group on an indexed column instead of reading JSON: at or above 100 is
 * CRITICAL, at or above `higherLaneMin` (50) TRANSACTIONAL, the rest BULK.
 */
export function laneOfPriority(priority: number, higherLaneMin = 50): MailLane {
  if (priority >= 100) return 'CRITICAL';
  if (priority >= higherLaneMin) return 'TRANSACTIONAL';
  return 'BULK';
}

/** The queue states an operator counts. RUNNING is a claimed row in a tick. */
export const QUEUE_STATES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELLED'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

export type LaneCounts = Record<MailLane, Record<QueueState, number>>;

export function emptyLaneCounts(): LaneCounts {
  const zero = () => Object.fromEntries(QUEUE_STATES.map((s) => [s, 0])) as Record<QueueState, number>;
  return { CRITICAL: zero(), TRANSACTIONAL: zero(), BULK: zero() };
}

/** Folds grouped (lane, status, count) rows into the fixed shape; a status
 *  outside QUEUE_STATES is ignored rather than invented. */
export function foldLaneCounts(rows: { lane: unknown; status: string; count: number }[]): LaneCounts {
  const out = emptyLaneCounts();
  for (const r of rows) {
    const lane = LANES.includes(r.lane as MailLane) ? (r.lane as MailLane) : 'CRITICAL';
    if ((QUEUE_STATES as readonly string[]).includes(r.status)) out[lane][r.status as QueueState] += r.count;
  }
  return out;
}

/** `Job.lastError` of a mail row is a reason code (`smtp_550_5.1.1`,
 *  `EAUTH:releases`, `expired`…). Anything that is not code-shaped — an older
 *  row, a handler's free text that might echo an address — is shown as
 *  `other`, never as itself. */
const CODE = /^[A-Za-z0-9_.:@-]{1,64}$/;
export function reasonCodeOf(lastError: string | null | undefined): string | null {
  if (!lastError) return null;
  return CODE.test(lastError) ? lastError : 'other';
}

/** How much of the recipient hash the screen shows: enough to tell two rows
 *  apart and to match a log line's `rcpt`, nothing an address can be read from. */
export const RCPT_PREFIX_LENGTH = 12;
export function recipientPrefix(rcpt: unknown): string | null {
  return typeof rcpt === 'string' && /^[0-9a-f]{16,}$/.test(rcpt) ? rcpt.slice(0, RCPT_PREFIX_LENGTH) : null;
}

// ── The two actions ─────────────────────────────────────────────────────────

export type QueueAction = 'retry' | 'cancel';

export type QueueActionRefusal = 'wrong_state' | 'expired' | 'no_envelope';

export interface QueueRowFacts {
  status: string;
  /** `payload.notAfter`, ISO. */
  notAfter: string | null | undefined;
  /** The sealed envelope is still on the row. */
  hasEnvelope: boolean;
}

/**
 * May an operator do this to that row now?
 *
 *   retry  — a FAILED (a 5xx) or DEAD_LETTER (attempts exhausted) mail goes
 *            back to PENDING with its attempts reset — only while its
 *            `notAfter` has not passed (a reset link past its expiry is worth
 *            nothing) and its envelope is still sealed on the row (a dead row
 *            keeps it until `notAfter`, see mailOutbox.ts).
 *   cancel — a PENDING mail is withdrawn. RUNNING is a drain's: never touched.
 *
 * The route still writes with a guarded `updateMany` on the state this read
 * saw: this rule decides, the WHERE makes it race-safe.
 */
export function queueActionAllowed(action: QueueAction, row: QueueRowFacts, now: Date): true | QueueActionRefusal {
  if (action === 'cancel') return row.status === 'PENDING' ? true : 'wrong_state';
  if (row.status !== 'FAILED' && row.status !== 'DEAD_LETTER') return 'wrong_state';
  const t = row.notAfter ? Date.parse(row.notAfter) : NaN;
  if (!Number.isFinite(t) || t <= now.getTime()) return 'expired';
  if (!row.hasEnvelope) return 'no_envelope';
  return true;
}

// ── Who sees which rows ─────────────────────────────────────────────────────

/**
 * The queue is the whole deployment's — both products, every tenant. Who may
 * read which part of it:
 *
 *   • a super admin: every row of their own world (rows whose organization is
 *     in that world; rows with no organization belong to the default world);
 *   • an ADMIN of the deployment's default organization: that organization's
 *     rows and the rows with no organization (operator alerts, mail to an
 *     address with no account yet), and nothing of any other tenant;
 *   • any other ADMIN, and every other role: nothing (403).
 *
 * The relay-wide facts (the breaker) are shown to both; today's count against
 * the daily cap only to a super admin — it is the whole relay's volume, the
 * figure `mailQueueNotice()` deliberately keeps from tenants.
 */
export type QueueScope =
  | { kind: 'world'; world: string; includeOrgless: boolean }
  | { kind: 'org'; orgId: string; includeOrgless: true };

export function queueScopeFor(facts: {
  role: string | null | undefined;
  superAdminWorld: string | null;
  orgId: string | null | undefined;
  defaultOrgId: string;
  defaultWorld: string;
}): QueueScope | null {
  if (facts.role !== 'ADMIN') return null;
  if (facts.superAdminWorld) {
    return { kind: 'world', world: facts.superAdminWorld, includeOrgless: facts.superAdminWorld === facts.defaultWorld };
  }
  if (facts.orgId && facts.orgId === facts.defaultOrgId) return { kind: 'org', orgId: facts.orgId, includeOrgless: true };
  return null;
}
