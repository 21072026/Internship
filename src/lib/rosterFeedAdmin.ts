import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { seal } from '@/lib/secretBox';
import { assertPublicHttpsUrl, SsrfBlockedError } from '@/lib/ssrfGuard';
import { isLoopbackStubUrl } from '@/lib/rosterIngest';
import { NextResponse } from 'next/server';
import type { RunFeedOutcome } from '@/lib/rosterFeedRunner';
import {
  ROSTER_FEED_LIMITS,
  ROSTER_FEED_SECRET_PURPOSE,
  nextFeedRun,
  validateFeedConfig,
  type RosterFeedError,
  type RosterFeedInput,
} from '@/lib/rosterFeed';

// The admin side of a roster feed's configuration (#1964): what
// /api/admin/roster-feeds reads and writes. The rules are in rosterFeed.ts;
// this file is where they meet the row and the sealed secret.
//
// THE SECRET. Written once through `seal(…, 'roster-feed-secret')` and never
// selected again by anything here: `PUBLIC_FEED_SELECT` does not name
// `secretEnc`, and the answer carries `secretSet: boolean` instead — the
// `ssoCertificateSet` pattern. The only reader of the sealed value is the run
// (`resolveFeedSecret` in rosterIngestStore.ts). It never goes into an
// ActivityLog detail, an error message or a log line.

/**
 * The e2e switch: lets the suite's local roster source (plain http on
 * 127.0.0.1) be saved and fetched. Set only by playwright.config.ts; never by
 * a deployment. Read per call.
 */
export function rosterStubAllowed(): boolean {
  return process.env.ROSTER_FEED_ALLOW_INSECURE_STUB === '1';
}

/** Every column an admin may read back. `secretEnc` is deliberately absent. */
export const PUBLIC_FEED_SELECT = {
  id: true,
  name: true,
  transport: true,
  enabled: true,
  url: true,
  sftpHost: true,
  sftpPort: true,
  sftpUsername: true,
  sftpPath: true,
  sftpHostKeyFingerprint: true,
  credentialEnvVar: true,
  delimiter: true,
  keyField: true,
  columnMap: true,
  authoritative: true,
  chunkSize: true,
  cronExpression: true,
  deprovision: true,
  maxDeactivatePercent: true,
  minRowCount: true,
  deprovisionGraceDays: true,
  lastRunAt: true,
  consecutiveFailures: true,
  pausedReason: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RosterFeedSelect;

type PublicFeedRow = Prisma.RosterFeedGetPayload<{ select: typeof PUBLIC_FEED_SELECT }>;

/** What a list or a banner needs of a feed's latest real run. */
export const RUN_SUMMARY_SELECT = {
  id: true,
  status: true,
  dryRun: true,
  startedAt: true,
  finishedAt: true,
  fileHash: true,
  rowCount: true,
  createdCount: true,
  updatedCount: true,
  unchangedCount: true,
  skippedCount: true,
  errorCount: true,
  deactivatedCount: true,
  reactivatedCount: true,
  safetyReason: true,
  error: true,
  approvedById: true,
  acknowledgedAt: true,
} as const satisfies Prisma.RosterRunSelect;

export type RunSummary = Prisma.RosterRunGetPayload<{ select: typeof RUN_SUMMARY_SELECT }>;

export type PublicRosterFeed = PublicFeedRow & {
  secretSet: boolean;
  /** The next scheduled run (UTC), or null when the feed has no schedule or is off. */
  nextRunAt: Date | null;
  /** The latest non-dry run. */
  lastRun: RunSummary | null;
};

/** Load this org's feed for the admin, or null — another org's id reads as absent. */
export async function loadPublicFeed(id: string, orgId: string): Promise<PublicRosterFeed | null> {
  const row = await prisma.rosterFeed.findFirst({
    where: { id, orgId },
    select: { ...PUBLIC_FEED_SELECT, secretEnc: true, runs: LAST_RUN },
  });
  return row ? toPublicFeed(row) : null;
}

export async function listPublicFeeds(orgId: string): Promise<PublicRosterFeed[]> {
  const rows = await prisma.rosterFeed.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: { ...PUBLIC_FEED_SELECT, secretEnc: true, runs: LAST_RUN },
  });
  return rows.map(toPublicFeed);
}

function toPublicFeed(
  row: PublicFeedRow & { secretEnc: string | null; runs?: RunSummary[] },
): PublicRosterFeed {
  const { secretEnc, runs, ...rest } = row;
  return {
    ...rest,
    secretSet: Boolean(secretEnc),
    nextRunAt: rest.enabled ? nextFeedRun(rest) : null,
    lastRun: runs?.[0] ?? null,
  };
}

const LAST_RUN = {
  where: { dryRun: false },
  orderBy: { startedAt: 'desc' },
  take: 1,
  select: RUN_SUMMARY_SELECT,
} as const;

/** One run of this org's feed, or null — another org's run reads as absent. */
export async function loadRun(feedId: string, runId: string, orgId: string): Promise<RunSummary | null> {
  return prisma.rosterRun.findFirst({ where: { id: runId, feedId, orgId }, select: RUN_SUMMARY_SELECT });
}

/** A spreadsheet cell that cannot become a formula (CSV injection). */
function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** RFC 4180, with a BOM so Excel reads UTF-8. */
export function toRunCsv(rows: { rowNumber: number; key: string; status: string; message: string | null; changed: unknown }[]): string {
  const header = ['row', 'key', 'action', 'message', 'changed'];
  const body = rows.map((r) => [
    r.rowNumber > 0 ? r.rowNumber : '',
    r.key,
    r.status,
    r.message ?? '',
    Array.isArray(r.changed) ? r.changed.join(' ') : '',
  ]);
  return '\uFEFF' + [header, ...body].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export type FeedWriteResult =
  | { ok: true; value: RosterFeedInput; secretEnc: string | null | undefined }
  | { ok: false; errors: RosterFeedError[] };

/**
 * Validate a create (no `current`) or an edit (merged over `current`), and work
 * out what happens to the secret: `undefined` = leave it, `null` = clear it, a
 * string = the new sealed value. An edit re-validates the WHOLE merged config,
 * so a PATCH that switches the transport cannot leave the other one's
 * requirements unchecked.
 *
 * The URL is checked against the SSRF guard here as well as before every
 * fetch: a feed that can never be fetched should not save.
 */
export async function prepareFeedWrite(
  body: Record<string, unknown>,
  current?: Record<string, unknown>,
): Promise<FeedWriteResult> {
  const merged = { ...(current ?? {}), ...body };
  const insecure = rosterStubAllowed();
  const checked = validateFeedConfig(merged, { allowInsecureLoopback: insecure });
  if (!checked.ok) return checked;

  const errors: RosterFeedError[] = [];
  let secretEnc: string | null | undefined;
  if (body.clearSecret === true) secretEnc = null;
  if (typeof body.secret === 'string' && body.secret.length > 0) {
    if (body.secret.length > ROSTER_FEED_LIMITS.secret) errors.push({ field: 'secret', code: 'too_long' });
    else secretEnc = seal(body.secret, ROSTER_FEED_SECRET_PURPOSE);
  }

  if (checked.value.transport === 'HTTPS' && checked.value.url && !(insecure && isLoopbackStubUrl(checked.value.url))) {
    try {
      await assertPublicHttpsUrl(checked.value.url);
    } catch (e) {
      if (!(e instanceof SsrfBlockedError)) throw e;
      errors.push({ field: 'url', code: 'blocked' });
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: checked.value, secretEnc };
}

/** The validated config as a Prisma write. */
export function feedWriteData(value: RosterFeedInput, secretEnc: string | null | undefined) {
  return {
    ...value,
    columnMap: value.columnMap as Prisma.InputJsonValue,
    ...(secretEnc !== undefined ? { secretEnc } : {}),
  };
}

/**
 * The answer to a manual run: what happened, in counts — never the rows (the
 * run detail pages them) and never the file.
 */
export function runResponse(outcome: RunFeedOutcome): NextResponse {
  if (outcome.status === 'claimed_elsewhere') {
    return NextResponse.json({ error: 'This feed is already running.', code: 'already_running' }, { status: 409 });
  }
  if (outcome.status === 'error') {
    return NextResponse.json({ error: outcome.message, code: 'run_failed' }, { status: 422 });
  }
  const r = outcome.result;
  return NextResponse.json({
    outcome: r.outcome,
    runId: r.run?.id ?? null,
    status: r.run?.status ?? null,
    dryRun: r.dryRun,
    counts: r.report?.counts ?? null,
    absent: r.absent.length,
    safety: r.safety ?? null,
    message: r.message ?? null,
    deprovision: r.deprovision
      ? {
          deactivate: r.deprovision.plan.deactivate.length,
          markAbsent: r.deprovision.plan.markAbsent.length,
          waiting: r.deprovision.plan.waiting.length,
          reactivate: r.deprovision.plan.reactivate.length,
          refused: r.deprovision.plan.refused.length,
          deactivated: r.deprovision.deactivated,
          reactivated: r.deprovision.reactivated,
        }
      : null,
  });
}
