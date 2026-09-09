// The Prisma side of the roster feed (#1965): persistence, one transaction per
// chunk, and the org-explicit entry point a scheduled run needs.
//
// WHY THIS IS A SEPARATE FILE
//   `src/lib/rosterIngest.ts` is the part that has to be unit-tested — the diff
//   and the resume protocol are where the bugs live, and neither needs a
//   database to be wrong. So the engine talks to ports (`RosterStore`,
//   `RosterRowWriter`) and this file is the only implementation that knows about
//   Prisma, bcrypt and the tenant middleware.
//
// THE TWO THINGS THIS FILE IS RESPONSIBLE FOR
//   1. **The chunk transaction.** Everything one chunk does — the user rows, the
//      per-row `RosterRowResult` entries and the `nextChunkIndex` checkpoint —
//      commits or rolls back together. That is what makes a crash mid-batch
//      resumable rather than a half-written roster (#1432's failure mode, on
//      the scheduled path).
//   2. **The tenant context.** A cron run has no session, so `withTenantScope`
//      is not available to it: `runRosterFeed()` binds the feed's own org with
//      `runWithOrg(feed.orgId, …)` for the whole run, and every query inside is
//      scoped by the middleware.

import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import type { $Enums, Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { runWithOrg } from './orgContext';
import { countRows, type RowStatus } from './importPreview';
import {
  applyPlannedRows,
  fetchFeedFile,
  ingestRoster,
  previewWriter,
  type RosterFeedConfig,
  type RosterIngestOptions,
  type RosterIngestResult,
  type RosterPlannedRow,
  type RosterRowResultData,
  type RosterRowWriter,
  type RosterRunRecord,
  type RosterRunStatus,
  type RosterStore,
  type RosterTargetRow,
} from './rosterIngest';

type TxClient = Prisma.TransactionClient;

const RUN_SELECT = {
  id: true,
  feedId: true,
  orgId: true,
  fileHash: true,
  dryRun: true,
  status: true,
  nextChunkIndex: true,
  startedAt: true,
} as const;

type RunRow = {
  id: string;
  feedId: string;
  orgId: string;
  fileHash: string;
  dryRun: boolean;
  status: $Enums.RosterRunStatus;
  nextChunkIndex: number;
  startedAt: Date;
};

// ── The row-status vocabulary, asserted in both directions ───────────────────
// `RosterRowStatus` in prisma/schema.prisma mirrors `RowStatus` in
// src/lib/importPreview.ts token for token, and nothing but these two functions
// says so. Persisting a token the enum does not have is a runtime error only, and
// reading one the engine does not know is the mirror image — so the conversion
// is an identity function in each direction rather than an `as` cast. Add a
// status to one side and this file stops compiling, which is the point: this is
// the only place in the tree where the two vocabularies meet.
function toRosterRowStatus(status: RowStatus): $Enums.RosterRowStatus {
  return status;
}

function fromRosterRowStatus(status: $Enums.RosterRowStatus): RowStatus {
  return status;
}

/** The same parity, for the run's own status. */
function fromRosterRunStatus(status: $Enums.RosterRunStatus): RosterRunStatus {
  return status;
}

function toRunRecord(row: RunRow): RosterRunRecord {
  return {
    id: row.id,
    feedId: row.feedId,
    orgId: row.orgId,
    fileHash: row.fileHash,
    dryRun: row.dryRun,
    status: fromRosterRunStatus(row.status),
    nextChunkIndex: row.nextChunkIndex,
    startedAt: row.startedAt,
  };
}

/** The people this feed is responsible for: the tenant's mentees. */
export async function loadRosterTarget(feed: RosterFeedConfig): Promise<RosterTargetRow[]> {
  const rows = await prisma.user.findMany({
    where: { orgId: feed.orgId, role: 'MENTEE' },
    select: {
      id: true,
      email: true,
      externalId: true,
      fullName: true,
      phone: true,
      university: true,
      department: true,
    },
  });
  return rows;
}

/**
 * The real writer, bound to one chunk's transaction.
 *
 * A created account gets a random bcrypt-hashed password, exactly like the
 * admin CSV importer: the person signs in through the password-reset or
 * invitation flow, and no importable file ever sets a usable credential.
 */
function prismaRowWriter(feed: RosterFeedConfig, tx: TxClient): RosterRowWriter {
  return {
    async create(row) {
      const { changes, feed: fed } = row.value;
      const email = (changes.email ?? fed.email ?? '').toLowerCase();
      const password = await bcrypt.hash(randomBytes(18).toString('hex'), 10);
      const created = await tx.user.create({
        data: {
          email,
          fullName: changes.fullName || email.split('@')[0],
          password,
          role: 'MENTEE',
          // The feed's org, explicitly — the run has no session for the
          // middleware to resolve one from.
          orgId: feed.orgId,
          externalId: changes.externalId ?? null,
          phone: changes.phone ?? null,
          university: changes.university ?? null,
          department: changes.department ?? null,
        },
        select: { id: true },
      });
      return created.id;
    },
    async update(row) {
      if (!row.targetId) throw new Error('An UPDATE row reached the writer with no target id');
      const { changes } = row.value;
      // `orgId` in the where is belt and braces on top of the middleware: this
      // is a background run, and a cross-tenant write here would be the worst
      // bug in the product.
      const result = await tx.user.updateMany({
        where: { id: row.targetId, orgId: feed.orgId },
        data: {
          ...(changes.email !== undefined ? { email: changes.email.toLowerCase() } : {}),
          ...(changes.externalId !== undefined ? { externalId: changes.externalId } : {}),
          ...(changes.fullName !== undefined ? { fullName: changes.fullName } : {}),
          ...(changes.phone !== undefined ? { phone: changes.phone } : {}),
          ...(changes.university !== undefined ? { university: changes.university } : {}),
          ...(changes.department !== undefined ? { department: changes.department } : {}),
        },
      });
      if (result.count === 0) {
        throw new Error('The row to update is not in this feed’s organisation');
      }
      return row.targetId;
    },
  };
}

/** The Prisma-backed store: runs, row results and the checkpoint. */
export function prismaRosterStore(feed: RosterFeedConfig): RosterStore {
  return {
    async lastSuccessfulRun(feedId) {
      const row = await prisma.rosterRun.findFirst({
        where: { feedId, dryRun: false, status: 'SUCCEEDED' },
        orderBy: { startedAt: 'desc' },
        select: RUN_SELECT,
      });
      return row ? toRunRecord(row) : null;
    },

    async findRun(feedId, fileHash, dryRun) {
      const row = await prisma.rosterRun.findFirst({
        where: { feedId, fileHash, dryRun },
        select: RUN_SELECT,
      });
      return row ? toRunRecord(row) : null;
    },

    async startRun(input) {
      const row = await prisma.rosterRun.create({
        data: {
          feedId: input.feedId,
          orgId: input.orgId,
          fileHash: input.fileHash,
          dryRun: input.dryRun,
          rowCount: input.rowCount,
          source: input.source,
          status: 'RUNNING',
        },
        select: RUN_SELECT,
      });
      return toRunRecord(row);
    },

    async reopenRun(run) {
      const row = await prisma.rosterRun.update({
        where: { id: run.id },
        // The checkpoint is deliberately NOT reset: re-opening a run is what
        // resuming means.
        data: { status: 'RUNNING', startedAt: new Date(), finishedAt: null, error: null },
        select: RUN_SELECT,
      });
      return toRunRecord(row);
    },

    async recordNoopRun(input) {
      // The same file may be seen unchanged on many nights, so the no-op reuses
      // the one row for (feed, hash) rather than growing the log every night.
      const existing = await prisma.rosterRun.findFirst({
        where: { feedId: input.feedId, fileHash: input.fileHash, dryRun: false },
        select: RUN_SELECT,
      });
      if (existing) return toRunRecord({ ...existing, status: existing.status });
      const row = await prisma.rosterRun.create({
        data: {
          feedId: input.feedId,
          orgId: input.orgId,
          fileHash: input.fileHash,
          dryRun: false,
          status: 'NOOP',
          source: input.source,
          finishedAt: new Date(),
        },
        select: RUN_SELECT,
      });
      return toRunRecord(row);
    },

    async recordedRows(runId) {
      const rows = await prisma.rosterRowResult.findMany({
        where: { runId },
        orderBy: { rowNumber: 'asc' },
        select: { rowNumber: true, key: true, status: true, message: true, userId: true },
      });
      return rows.map((row) => ({
        row: row.rowNumber,
        key: row.key,
        status: fromRosterRowStatus(row.status),
        ...(row.message ? { reason: row.message } : {}),
        targetId: row.userId,
      }));
    },

    async commitChunk({ run, chunkIndex, rows }) {
      // ONE transaction: the user writes, the row results and the checkpoint.
      return prisma.$transaction(async (tx) => {
        const writer = run.dryRun ? previewWriter : prismaRowWriter(feed, tx);
        const results = await applyPlannedRows(rows, writer);

        for (const result of results) {
          const message =
            result.reason ??
            (result.value?.withheld.length ? `left alone: ${result.value.withheld.join(', ')}` : null);
          const data = {
            orgId: run.orgId,
            chunkIndex,
            key: result.key.slice(0, 255),
            status: toRosterRowStatus(result.status),
            changed: (result.changed ?? []) as Prisma.InputJsonValue,
            message,
            userId: result.targetId ?? null,
          };
          await tx.rosterRowResult.upsert({
            where: { runId_rowNumber: { runId: run.id, rowNumber: result.row } },
            create: { runId: run.id, rowNumber: result.row, ...data },
            update: data,
          });
        }

        // The checkpoint is CONTIGUOUS: it advances only when this chunk is the
        // one it was waiting for. A chunk that failed therefore freezes it, and
        // the next run re-attempts from there instead of skipping the gap for
        // ever. Re-attempting is safe because the plan is re-derived against
        // the live roster — an already-applied row comes back UNCHANGED.
        const current = await tx.rosterRun.findUnique({
          where: { id: run.id },
          select: { nextChunkIndex: true },
        });
        if (current && current.nextChunkIndex === chunkIndex) {
          await tx.rosterRun.update({
            where: { id: run.id },
            data: { nextChunkIndex: chunkIndex + 1 },
          });
        }
        return results;
      });
    },

    async finishRun({ run, status, counts, absent, error }) {
      await prisma.rosterRun.update({
        where: { id: run.id },
        data: {
          status,
          finishedAt: new Date(),
          createdCount: counts.CREATE,
          updatedCount: counts.UPDATE,
          unchangedCount: counts.UNCHANGED,
          skippedCount: counts.SKIP,
          errorCount: counts.ERROR,
          absentKeys: absent as Prisma.InputJsonValue,
          ...(error !== undefined ? { error } : {}),
        },
      });
    },
  };
}

/** A stored feed row, as the engine wants it. */
export function toFeedConfig(row: {
  id: string;
  orgId: string;
  name: string;
  transport: string;
  url: string | null;
  sftpHost: string | null;
  sftpPort: number | null;
  sftpUsername: string | null;
  sftpPath: string | null;
  sftpHostKeyFingerprint: string | null;
  credentialEnvVar: string | null;
  delimiter: string | null;
  keyField: string;
  columnMap: unknown;
  authoritative: boolean;
  chunkSize: number | null;
}): RosterFeedConfig {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    transport: row.transport as RosterFeedConfig['transport'],
    url: row.url,
    sftpHost: row.sftpHost,
    sftpPort: row.sftpPort,
    sftpUsername: row.sftpUsername,
    sftpPath: row.sftpPath,
    sftpHostKeyFingerprint: row.sftpHostKeyFingerprint,
    credentialEnvVar: row.credentialEnvVar,
    delimiter: row.delimiter,
    keyField: row.keyField as RosterFeedConfig['keyField'],
    columnMap:
      row.columnMap && typeof row.columnMap === 'object'
        ? (row.columnMap as RosterFeedConfig['columnMap'])
        : {},
    authoritative: row.authoritative,
    chunkSize: row.chunkSize,
  };
}

const FEED_SELECT = {
  id: true,
  orgId: true,
  name: true,
  transport: true,
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
} as const;

/**
 * Run one stored feed, with its own org bound for the whole run.
 *
 * This is the entry point both a route handler and a scheduled job call. It
 * takes no session on purpose — `withTenantScope(session, …)` is unavailable to
 * a background run, and resolving the org from anything other than the feed row
 * itself is how a background job ends up writing into the wrong tenant.
 */
export async function runRosterFeed(
  feedId: string,
  options: RosterIngestOptions = {},
): Promise<RosterIngestResult> {
  // Read the feed outside any tenant scope (there is none yet — the feed row is
  // what says which tenant this is), then bind that org for everything after.
  const row = await runWithOrg(null, () =>
    prisma.rosterFeed.findUnique({ where: { id: feedId }, select: FEED_SELECT }),
  );
  if (!row) throw new Error(`No roster feed ${feedId}`);
  const feed = toFeedConfig(row);

  return runWithOrg(feed.orgId, () =>
    ingestRoster(
      feed,
      {
        store: prismaRosterStore(feed),
        loadTarget: loadRosterTarget,
        fetchFile: (f) => fetchFeedFile(f),
      },
      options,
    ),
  );
}

/**
 * Run every enabled feed, one tenant at a time. The scheduled caller (a cron
 * tick or `/api/cron`) is expected to log the result; one feed failing must not
 * stop the others.
 */
export async function sweepRosterFeeds(
  options: RosterIngestOptions = {},
): Promise<{ feedId: string; outcome: string; error?: string }[]> {
  const feeds = await runWithOrg(null, () =>
    prisma.rosterFeed.findMany({ where: { enabled: true }, select: { id: true } }),
  );
  const out: { feedId: string; outcome: string; error?: string }[] = [];
  for (const feed of feeds) {
    try {
      const result = await runRosterFeed(feed.id, options);
      out.push({ feedId: feed.id, outcome: result.outcome });
    } catch (error) {
      out.push({
        feedId: feed.id,
        outcome: 'ERROR',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

/** Totals for a finished run, in the shape the report uses. */
export function runTotals(rows: RosterRowResultData[]): Record<RowStatus, number> {
  return countRows(rows);
}

export type { RosterPlannedRow };
