import { createHmac, randomUUID } from 'crypto';

// The audit stream (#2012) — the rules half, Prisma-free so
// scripts/test/audit-drain.test.mjs can pin every decision without a database.
// The row access, the HTTP delivery and the schedule live in
// src/lib/auditDrain.ts; the contract a receiver programs against is written
// down in docs/audit-stream.md and this file is what that document describes.
//
// WHAT A DRAIN IS. One tenant's AuditLog rows, read forward from a cursor,
// POSTed as newline-delimited JSON with an HMAC-SHA256 signature over the
// batch body. The cursor is the (createdAt, id) of the last row shipped and
// moves ONLY when the receiver answered 2xx — so an outage replays, never
// loses. That makes delivery at-least-once: a receiver that stores rows keys
// them by `id` and treats a repeat as a no-op.
//
// WHAT A DRAIN IS NOT. It never edits or deletes an audit row, it never reads
// another tenant's rows (the Prisma half filters by the drain's own orgId and
// the test batch below is synthetic), and it adds no retention of its own: the
// age-based sweep is #1585's, on #1678's single schedule. The one way the two
// interact — a row swept before it is shipped is gone silently — is why the
// retention window is a floor on how long a drain may be down.

export const AUDIT_DRAIN_FORMATS = ['json_lines', 'ecs'] as const;
export type AuditDrainFormat = (typeof AUDIT_DRAIN_FORMATS)[number];

export function isAuditDrainFormat(value: unknown): value is AuditDrainFormat {
  return typeof value === 'string' && (AUDIT_DRAIN_FORMATS as readonly string[]).includes(value);
}

/** Rows per POST. Small enough for a HEC-style collector's default body limit. */
export const AUDIT_DRAIN_BATCH_SIZE = 200;
/** Batches one tick ships per drain before yielding — a long outage catches up over a few ticks, not in one request. */
export const AUDIT_DRAIN_MAX_BATCHES_PER_TICK = 10;
/** A receiver that cannot take 200 lines in ten seconds is treated as down. */
export const AUDIT_DRAIN_TIMEOUT_MS = 10_000;
/** Consecutive failures after which the drain pauses itself (≈ 3.5 days at the capped backoff) rather than retrying forever. */
export const AUDIT_DRAIN_PAUSE_AFTER_FAILURES = 20;
/** The URL column is @db.Text; the route caps what a person may paste. */
export const AUDIT_DRAIN_URL_MAX = 2000;
/** `AuditDrain.format` as the HTTP header the receiver reads. */
export const AUDIT_DRAIN_CONTENT_TYPE = 'application/x-ndjson';

/** The subset of an AuditLog row the stream carries — the whole row, in fact. */
export interface AuditStreamRow {
  id: string;
  orgId: string | null;
  actorId: string;
  action: string;
  targetId: string | null;
  detail: string | null;
  createdAt: Date;
}

export interface AuditCursor {
  cursorAt: Date;
  cursorId: string;
}

// ── Encoding ────────────────────────────────────────────────────────────────

/**
 * `detail` is free text today, JSON for a user merge. A receiver gets it as
 * structured data when it parses, as the string otherwise; it is never dropped.
 */
export function detailValue(detail: string | null): unknown {
  if (detail === null || detail === undefined) return null;
  const trimmed = detail.trim();
  if (!trimmed) return null;
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      return JSON.parse(trimmed);
    } catch {
      return detail;
    }
  }
  return detail;
}

/** Our own record: every column, named as the table names it. */
export function encodeJsonLine(row: AuditStreamRow): Record<string, unknown> {
  return {
    id: row.id,
    orgId: row.orgId,
    action: row.action,
    actorId: row.actorId,
    targetId: row.targetId,
    detail: detailValue(row.detail),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Elastic Common Schema, the subset every SIEM maps: `@timestamp`, `event.*`,
 * `user.id` for the actor, `related.user` for everyone the row names, and the
 * tenant under `organization.id`. The whole original record rides along under
 * `interncrm.audit` so nothing is lost to the mapping.
 */
export function encodeEcs(row: AuditStreamRow): Record<string, unknown> {
  const related = [row.actorId, row.targetId].filter((v): v is string => !!v);
  return {
    '@timestamp': row.createdAt.toISOString(),
    event: { id: row.id, action: row.action, kind: 'event', dataset: 'interncrm.audit', created: row.createdAt.toISOString() },
    user: { id: row.actorId },
    ...(row.targetId ? { user_target: { id: row.targetId } } : {}),
    related: { user: [...new Set(related)] },
    ...(row.orgId ? { organization: { id: row.orgId } } : {}),
    message: `${row.action} by ${row.actorId}${row.targetId ? ` on ${row.targetId}` : ''}`,
    interncrm: { audit: encodeJsonLine(row) },
  };
}

export function encodeRecord(row: AuditStreamRow, format: AuditDrainFormat): Record<string, unknown> {
  return format === 'ecs' ? encodeEcs(row) : encodeJsonLine(row);
}

/** One JSON object per line, newline-terminated — what `application/x-ndjson` means. */
export function encodeBatch(rows: readonly AuditStreamRow[], format: AuditDrainFormat): string {
  return rows.map((row) => JSON.stringify(encodeRecord(row, format))).join('\n') + (rows.length ? '\n' : '');
}

// ── Signing ─────────────────────────────────────────────────────────────────

/** `sha256=<hex>` over the exact bytes of the body — the recipe in docs/audit-stream.md. */
export function signBatch(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

export interface BatchHeadersInput {
  signature: string;
  batchId: string;
  count: number;
  format: AuditDrainFormat;
  /** True for the synthetic test batch, so a receiver can keep it out of its real index. */
  test?: boolean;
}

export function batchHeaders(input: BatchHeadersInput): Record<string, string> {
  return {
    'Content-Type': AUDIT_DRAIN_CONTENT_TYPE,
    'X-Signature': input.signature,
    'X-Audit-Batch-Id': input.batchId,
    'X-Audit-Count': String(input.count),
    'X-Audit-Format': input.format,
    ...(input.test ? { 'X-Audit-Test': '1' } : {}),
  };
}

export function newBatchId(): string {
  return randomUUID();
}

// ── Cursor ──────────────────────────────────────────────────────────────────

/** The cursor after shipping `rows` (in (createdAt, id) order): the last row. */
export function cursorAfter(rows: readonly AuditStreamRow[]): AuditCursor | null {
  const last = rows[rows.length - 1];
  return last ? { cursorAt: last.createdAt, cursorId: last.id } : null;
}

/**
 * Is `row` after `cursor` in the stream's total order? The Prisma half asks
 * the database the same question (`createdAt > at OR (createdAt = at AND id >
 * id)`); this is the predicate the tests pin so the two cannot disagree.
 */
export function isAfterCursor(row: Pick<AuditStreamRow, 'id' | 'createdAt'>, cursor: AuditCursor | null): boolean {
  if (!cursor) return true;
  const t = row.createdAt.getTime();
  const c = cursor.cursorAt.getTime();
  return t > c || (t === c && row.id > cursor.cursorId);
}

// ── Scheduling: backoff, pause, due ─────────────────────────────────────────

const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;

/** How long to wait after the n-th consecutive failure (1-based). Capped at six hours. */
export function backoffMs(failures: number): number {
  const i = Math.max(1, Math.trunc(failures)) - 1;
  return BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
}

export interface DrainScheduleState {
  active: boolean;
  failures: number;
  nextAttemptAt: Date | null;
}

/** Due = active and not held back by a backoff. */
export function isDue(drain: DrainScheduleState, now: Date): boolean {
  return drain.active && (!drain.nextAttemptAt || drain.nextAttemptAt.getTime() <= now.getTime());
}

export type DeliveryOutcome =
  | { ok: true; rows: readonly AuditStreamRow[] }
  | { ok: false; error: string };

export interface DrainStatePatch {
  cursorAt?: Date;
  cursorId?: string;
  lastOkAt?: Date;
  lastError: string | null;
  failures: number;
  nextAttemptAt: Date | null;
  active?: false;
}

/**
 * The state machine, as one pure function: what the row looks like after an
 * attempt. A success moves the cursor to the last shipped row and clears the
 * failure count; a failure leaves the cursor where it was (replay, never
 * loss), counts, backs off, and past the ceiling pauses the drain with the
 * reason in `lastError` — a receiver that has been down for days is a human's
 * problem, not something to retry every six hours forever.
 */
export function afterAttempt(state: DrainScheduleState, outcome: DeliveryOutcome, now: Date): DrainStatePatch {
  if (outcome.ok) {
    const cursor = cursorAfter(outcome.rows);
    return {
      ...(cursor ? { cursorAt: cursor.cursorAt, cursorId: cursor.cursorId } : {}),
      lastOkAt: now,
      lastError: null,
      failures: 0,
      nextAttemptAt: null,
    };
  }
  const failures = state.failures + 1;
  if (failures >= AUDIT_DRAIN_PAUSE_AFTER_FAILURES) {
    return {
      lastError: `${outcome.error} — paused after ${failures} consecutive failures; resume the drain once the receiver is back`,
      failures,
      nextAttemptAt: null,
      active: false,
    };
  }
  return {
    lastError: outcome.error,
    failures,
    nextAttemptAt: new Date(now.getTime() + backoffMs(failures)),
  };
}

// ── URL rule ────────────────────────────────────────────────────────────────

export type DrainUrlRefusal = 'invalid' | 'not_https' | 'credentials' | 'too_long';

/**
 * The shape check a receiver URL passes before the SSRF guard sees it: https
 * only, no credentials in the authority, within the column cap. `allowInsecure`
 * is the e2e switch (AUDIT_DRAIN_ALLOW_INSECURE_RECEIVERS) that lets the local
 * sink speak plain http on a loopback port; it is never set on a deployment.
 */
export function checkDrainUrlShape(raw: string, opts: { allowInsecure?: boolean } = {}): { ok: true; url: string } | { ok: false; reason: DrainUrlRefusal } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'invalid' };
  if (trimmed.length > AUDIT_DRAIN_URL_MAX) return { ok: false, reason: 'too_long' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:' && !(opts.allowInsecure && url.protocol === 'http:')) return { ok: false, reason: 'not_https' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  return { ok: true, url: trimmed };
}

// ── The synthetic test batch ────────────────────────────────────────────────

/**
 * What "send a test batch" ships: two invented rows that look exactly like
 * real ones and name nobody. Real rows never leave through the test button —
 * it exists to prove the receiver and the signature, not to replay history.
 */
export function syntheticTestRows(orgId: string, now: Date): AuditStreamRow[] {
  const base = now.getTime();
  return [
    {
      id: `test-${base}-1`,
      orgId,
      actorId: 'test-actor',
      action: 'audit.drain.test',
      targetId: null,
      detail: JSON.stringify({ test: true, note: 'synthetic row — not an event that happened' }),
      createdAt: new Date(base - 1000),
    },
    {
      id: `test-${base}-2`,
      orgId,
      actorId: 'test-actor',
      action: 'audit.drain.test',
      targetId: 'test-target',
      detail: null,
      createdAt: new Date(base),
    },
  ];
}
