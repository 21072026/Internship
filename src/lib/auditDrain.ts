import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { sanitizeError } from '@/lib/sanitizeError';
import { assertPublicHttpsUrl, SsrfBlockedError } from '@/lib/ssrfGuard';
import { runWithOrg } from '@/lib/orgContext';
import {
  AUDIT_DRAIN_BATCH_SIZE,
  AUDIT_DRAIN_MAX_BATCHES_PER_TICK,
  AUDIT_DRAIN_TIMEOUT_MS,
  afterAttempt,
  batchHeaders,
  checkDrainUrlShape,
  encodeBatch,
  isAuditDrainFormat,
  isDue,
  newBatchId,
  signBatch,
  syntheticTestRows,
  type AuditDrainFormat,
  type AuditStreamRow,
  type DrainUrlRefusal,
} from '@/lib/auditDrainRule';

// The audit stream (#2012) — the Prisma/HTTP half. The rules it applies are in
// auditDrainRule.ts (pure, unit-tested); the receiver's contract is
// docs/audit-stream.md.
//
// ONE TICK, PLATFORM-WIDE. `runAuditDrains()` walks every due drain of every
// tenant and ships its next batches. It runs outside any request scope — the
// queued `audit.drain` job, or the admin's `/api/cron?job=audit-drain` — so it binds
// `runWithOrg(null, …)` explicitly and scopes every AuditLog read by the
// drain's OWN orgId in the `where`. That filter is the whole isolation story:
// a drain never sees a row of another tenant because the query never asks for
// one. NULL-org rows (legacy, system) are deliberately NOT folded into the
// default org here the way tenantFilter does for reads: the deploy backfill
// (prisma/backfill-audit-log-org.mjs → backfill-organization.mjs) attributes
// them first, and a row that is still NULL is a row whose tenant is unknown,
// which no tenant's SIEM should receive.
//
// NO WRITES TO AuditLog. This module reads the trail and updates its own
// bookkeeping row; nothing in it, or anywhere else, edits or deletes an audit
// row — only the age-based sweep (#1585, on #1678's schedule) may, and this
// module adds no retention of its own.
//
// THE SCHEDULE. Every five minutes as the queued job `'audit.drain'` (#1676,
// src/lib/jobs/schedules.ts), run by the job worker; `runAuditDrains()` is the
// handler. Backoff and the pause after repeated failures live on
// the drain row itself (afterAttempt), so a receiver outage is retried on its
// own clock rather than hammered every tick.

export class DrainUrlError extends Error {
  constructor(public readonly reason: DrainUrlRefusal) {
    super(reason);
  }
}

/**
 * The e2e switch: lets the local sink speak plain http on a loopback port, and
 * skips the SSRF resolution for it. Set only by playwright.config.ts's
 * webServer env; never by the deploy. Read per call, not once, so a test can
 * flip it without a restart.
 */
export function insecureReceiversAllowed(): boolean {
  return process.env.AUDIT_DRAIN_ALLOW_INSECURE_RECEIVERS === '1';
}

/**
 * Shape check, then the SSRF guard — at registration and AGAIN at every
 * delivery (#893: DNS moves, and a row created before a rule existed has
 * never been checked by it). Returns the URL as it will be stored/called.
 */
export async function assertDrainUrl(raw: string): Promise<string> {
  const insecure = insecureReceiversAllowed();
  const shape = checkDrainUrlShape(raw, { allowInsecure: insecure });
  if (!shape.ok) throw new DrainUrlError(shape.reason);
  if (insecure) {
    logger.warning('audit drain: insecure receiver allowed by AUDIT_DRAIN_ALLOW_INSECURE_RECEIVERS (test switch)');
    return shape.url;
  }
  await assertPublicHttpsUrl(shape.url);
  return shape.url;
}

export interface DrainRow {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  format: string;
  active: boolean;
  cursorAt: Date | null;
  cursorId: string | null;
  failures: number;
  nextAttemptAt: Date | null;
}

const DRAIN_SELECT = {
  id: true,
  orgId: true,
  url: true,
  secret: true,
  format: true,
  active: true,
  cursorAt: true,
  cursorId: true,
  failures: true,
  nextAttemptAt: true,
} as const;

const ROW_SELECT = {
  id: true,
  orgId: true,
  actorId: true,
  action: true,
  targetId: true,
  detail: true,
  createdAt: true,
} as const;

function formatOf(drain: Pick<DrainRow, 'format'>): AuditDrainFormat {
  return isAuditDrainFormat(drain.format) ? drain.format : 'json_lines';
}

export type FetchLike = (url: string, init: RequestInit) => Promise<{ status: number }>;

/**
 * POST one batch. Throws on anything that is not a 2xx — a refused URL, a
 * timeout, a 5xx — and the caller turns the throw into the row's bookkeeping.
 */
export async function postBatch(
  drain: Pick<DrainRow, 'url' | 'secret' | 'format'>,
  rows: readonly AuditStreamRow[],
  opts: { test?: boolean; fetchImpl?: FetchLike } = {},
): Promise<{ status: number }> {
  const url = await assertDrainUrl(drain.url);
  const format = formatOf(drain);
  const body = encodeBatch(rows, format);
  const headers = batchHeaders({
    signature: signBatch(drain.secret, body),
    batchId: newBatchId(),
    count: rows.length,
    format,
    test: opts.test,
  });
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(AUDIT_DRAIN_TIMEOUT_MS),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return { status: res.status };
}

/**
 * The rows after the cursor, in the stream's total order (createdAt, id). The
 * orgId term is the tenant boundary — see the header.
 */
function nextRowsWhere(drain: Pick<DrainRow, 'orgId' | 'cursorAt' | 'cursorId'>): Prisma.AuditLogWhereInput {
  if (!drain.cursorAt || !drain.cursorId) return { orgId: drain.orgId };
  return {
    orgId: drain.orgId,
    OR: [{ createdAt: { gt: drain.cursorAt } }, { createdAt: drain.cursorAt, id: { gt: drain.cursorId } }],
  };
}

function errorText(e: unknown): string {
  if (e instanceof DrainUrlError) return `receiver URL refused: ${e.reason}`;
  if (e instanceof SsrfBlockedError) return `receiver URL refused: ${e.message}`;
  const raw = e instanceof Error ? (e.name === 'TimeoutError' ? `timeout after ${AUDIT_DRAIN_TIMEOUT_MS} ms` : e.message) : String(e);
  return sanitizeError(raw) ?? 'delivery failed';
}

export interface ShipResult {
  drainId: string;
  batches: number;
  rows: number;
  ok: boolean;
  paused: boolean;
  error: string | null;
}

/**
 * Ship a drain's next batches: read forward from the cursor, POST, move the
 * cursor on 2xx, stop at the first failure (bookkeeping per afterAttempt).
 * Up to AUDIT_DRAIN_MAX_BATCHES_PER_TICK batches, so a long outage catches up
 * over a few ticks rather than in one unbounded loop.
 */
export async function shipDrain(drain: DrainRow, opts: { now?: Date; fetchImpl?: FetchLike } = {}): Promise<ShipResult> {
  const result: ShipResult = { drainId: drain.id, batches: 0, rows: 0, ok: true, paused: false, error: null };
  let cur: DrainRow = { ...drain };
  for (let i = 0; i < AUDIT_DRAIN_MAX_BATCHES_PER_TICK; i++) {
    const rows = await prisma.auditLog.findMany({
      where: nextRowsWhere(cur),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: AUDIT_DRAIN_BATCH_SIZE,
      select: ROW_SELECT,
    });
    if (rows.length === 0) break;
    const now = opts.now ?? new Date();
    try {
      await postBatch(cur, rows, { fetchImpl: opts.fetchImpl });
      const patch = afterAttempt(cur, { ok: true, rows }, now);
      await prisma.auditDrain.update({ where: { id: cur.id }, data: patch });
      cur = { ...cur, cursorAt: patch.cursorAt ?? cur.cursorAt, cursorId: patch.cursorId ?? cur.cursorId, failures: 0, nextAttemptAt: null };
      result.batches += 1;
      result.rows += rows.length;
    } catch (e) {
      const patch = afterAttempt(cur, { ok: false, error: errorText(e) }, now);
      await prisma.auditDrain.update({ where: { id: cur.id }, data: patch });
      result.ok = false;
      result.paused = patch.active === false;
      result.error = patch.lastError;
      logger.warning('audit drain delivery failed', { drainId: cur.id, failures: patch.failures, paused: result.paused, error: patch.lastError });
      break;
    }
    if (rows.length < AUDIT_DRAIN_BATCH_SIZE) break;
  }
  return result;
}

export interface AuditDrainTick {
  drains: number;
  due: number;
  batches: number;
  rows: number;
  failed: number;
  paused: number;
}

/**
 * One tick: every active drain whose backoff has elapsed, platform-wide.
 * Counters only (the admin console renders them), never a URL or a row.
 */
export async function runAuditDrains(opts: { now?: Date; fetchImpl?: FetchLike; drainId?: string } = {}): Promise<AuditDrainTick> {
  return runWithOrg(null, async () => {
    const now = opts.now ?? new Date();
    const drains = await prisma.auditDrain.findMany({
      where: { active: true, ...(opts.drainId ? { id: opts.drainId } : {}) },
      select: DRAIN_SELECT,
    });
    const tick: AuditDrainTick = { drains: drains.length, due: 0, batches: 0, rows: 0, failed: 0, paused: 0 };
    for (const drain of drains) {
      if (!isDue(drain, now)) continue;
      tick.due += 1;
      const r = await shipDrain(drain, { now, fetchImpl: opts.fetchImpl });
      tick.batches += r.batches;
      tick.rows += r.rows;
      if (!r.ok) tick.failed += 1;
      if (r.paused) tick.paused += 1;
    }
    return tick;
  });
}

/**
 * "Send a test batch": two synthetic rows (auditDrainRule.syntheticTestRows),
 * never real ones, flagged `X-Audit-Test: 1`. Records the outcome on the row
 * so the console shows it, but does NOT count towards the failure ceiling or
 * move the cursor — a button press must not pause a drain or skip history.
 */
export async function deliverTestBatch(
  drain: Pick<DrainRow, 'id' | 'orgId' | 'url' | 'secret' | 'format'>,
  opts: { now?: Date; fetchImpl?: FetchLike } = {},
): Promise<{ ok: true; status: number } | { ok: false; error: string }> {
  const now = opts.now ?? new Date();
  try {
    const { status } = await postBatch(drain, syntheticTestRows(drain.orgId, now), { test: true, fetchImpl: opts.fetchImpl });
    await prisma.auditDrain.update({ where: { id: drain.id }, data: { lastOkAt: now, lastError: null } });
    return { ok: true, status };
  } catch (e) {
    const error = errorText(e);
    await prisma.auditDrain.update({ where: { id: drain.id }, data: { lastError: error } });
    return { ok: false, error };
  }
}

// ── Schedule ────────────────────────────────────────────────────────────────
//
// Scheduled by the queue (#1676): `audit.drain` in src/lib/jobs/schedules.ts,
// every five minutes under the 'scheduler' lease, run by its handler in
// src/jobs/index.ts. A doubled tick is harmless: the cursor only moves forward
// and the receiver dedupes on the row id.
