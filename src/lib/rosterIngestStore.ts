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
import { runUnscoped } from './tenantAmbient';
import { findUsersInWorld, worldOfOrg } from './userWorld';
import type { VerticalKey } from './verticals';
import { countRows, type RowStatus } from './importPreview';
import {
  applyPlannedRows,
  fetchFeedFile,
  ingestRoster,
  previewWriter,
  RosterTransportError,
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
  type FeedFile,
} from './rosterIngest';
import { ROSTER_FEED_SECRET_PURPOSE } from './rosterFeed';
import { open } from './secretBox';
import { logActivity } from './activity';
import { revokeTrustedDevicesForUsers } from './trustedDevice';
import { rosterActor, type DeprovisionSettings } from './rosterDeprovisionRule';
import type { RosterDeprovisionPort } from './rosterIngest';
import { alertRosterRun } from './rosterAlert';
import { createUser } from '@/lib/userCreate';

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
  // The deprovisioning phase's two (#1966) are not import rows: they live on
  // negative row numbers, which `recordedRows` never reads.
  if (status === 'DEACTIVATE' || status === 'REACTIVATE') {
    throw new Error(`Roster row status ${status} is not an import row`);
  }
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
 * Does ANOTHER organization of this feed's product already hold `email`?
 *
 * ONE PERSON, TWO WORLDS (#2590): an address may be an account in the
 * internship product and another in the marketing product, but only one per
 * product. Before worlds the global unique on `User.email` turned every clash
 * into a P2002 for this writer; now the database only refuses two rows in the
 * SAME organization (`@@unique([email, orgId])`, and that renders in the run
 * log exactly as it always did). A holder in a second organization of the same
 * product is the case only this check can see — and a roster feed must not be
 * the door through which two accounts of one address end up in one world.
 *
 * What it deliberately does NOT do is treat the person's account in the OTHER
 * product as a clash: that is the whole feature. `findUsersInWorld` is asked
 * about the feed's own world, so a marketing-only holder of the address is
 * invisible here and the row is created as usual.
 *
 * Read outside the tenant filter (`runUnscoped`): the run is bound to the
 * feed's org with `runWithOrg`, and under MT_ENFORCE_ISOLATION that would hide
 * exactly the other-tenant holder this looks for. `select` is id + org only, so
 * nothing about the other account leaves this function but a yes/no.
 */
async function heldByOtherOrgInWorld(
  email: string,
  world: VerticalKey,
  orgId: string,
  exceptUserId?: string,
): Promise<boolean> {
  if (!email) return false;
  const holders = await runUnscoped(() => findUsersInWorld(email, world, { id: true, orgId: true }));
  return holders.some((h) => h.orgId !== orgId && h.id !== exceptUserId);
}

/**
 * The real writer, bound to one chunk's transaction.
 *
 * A created account gets a random bcrypt-hashed password, exactly like the
 * admin CSV importer: the person signs in through the password-reset or
 * invitation flow, and no importable file ever sets a usable credential.
 */
function prismaRowWriter(feed: RosterFeedConfig, tx: TxClient): RosterRowWriter {
  // The feed's world, read once per chunk on first use — every row of a chunk
  // asks the same question about the same organization.
  let feedWorld: Promise<VerticalKey> | null = null;
  const world = () => (feedWorld ??= worldOfOrg(feed.orgId));
  return {
    async create(row) {
      const { changes, feed: fed } = row.value;
      const email = (changes.email ?? fed.email ?? '').toLowerCase();
      if (await heldByOtherOrgInWorld(email, await world(), feed.orgId)) {
        throw new Error('an account with this e-mail address already exists');
      }
      const password = await bcrypt.hash(randomBytes(18).toString('hex'), 10);
      const created = await createUser(tx, {
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
      }, { source: 'roster' });
      return created.id;
    },
    async update(row) {
      if (!row.targetId) throw new Error('An UPDATE row reached the writer with no target id');
      const { changes } = row.value;
      // An e-mail change is the other way to end up with a second account of
      // one address in one product (#2590) — same rule as a create.
      if (
        changes.email !== undefined &&
        (await heldByOtherOrgInWorld(changes.email.toLowerCase(), await world(), feed.orgId, row.targetId))
      ) {
        throw new Error('an account with this e-mail address already exists');
      }
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
        // File rows only: the deprovisioning phase's rows sit below zero.
        where: { runId, rowNumber: { gt: 0 } },
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

    async finishRun({ run, status, counts, absent, error, safetyReason }) {
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
          ...(safetyReason !== undefined ? { safetyReason } : {}),
        },
      });
    },
  };
}

const CANDIDATE_SELECT = {
  id: true,
  role: true,
  isActive: true,
  ssoExempt: true,
  rosterAbsentSince: true,
  deactivatedBy: true,
} as const;

/**
 * The deprovisioning port (#1966): reads the people the rules judge and writes
 * what they decide. Every write is scoped by `(id, orgId)` on top of the tenant
 * middleware, and re-checks the state it expects in its WHERE, so a person a
 * human changed between plan and apply is left alone.
 *
 * Nothing here deletes or anonymises. Deactivation is reversible.
 */
export function prismaDeprovisionPort(
  feed: RosterFeedConfig,
  settings: DeprovisionSettings,
): RosterDeprovisionPort {
  const orgId = feed.orgId;
  const actor = rosterActor(feed.id);
  return {
    settings,

    async load({ absentIds, presentIds }) {
      const [absent, present, coveredActiveCount, activeAdminCount] = await Promise.all([
        absentIds.length
          ? prisma.user.findMany({ where: { id: { in: absentIds }, orgId }, select: CANDIDATE_SELECT })
          : [],
        presentIds.length
          ? prisma.user.findMany({ where: { id: { in: presentIds }, orgId }, select: CANDIDATE_SELECT })
          : [],
        // The ceiling's denominator: the active people this feed covers — the
        // same population `loadRosterTarget` reads.
        prisma.user.count({ where: { orgId, role: 'MENTEE', isActive: true } }),
        prisma.user.count({ where: { orgId, role: 'ADMIN', isActive: true } }),
      ]);
      return { absent, present, coveredActiveCount, activeAdminCount };
    },

    async apply({ run, plan, keys }) {
      const stamp = new Date();
      let reactivated = 0;
      if (plan.reactivate.length) {
        // Only what a feed switched off — `deactivatedBy` in the WHERE is the
        // guarantee that an admin's decision is never undone by a file.
        ({ count: reactivated } = await prisma.user.updateMany({
          where: { id: { in: plan.reactivate }, orgId, isActive: false, deactivatedBy: actor },
          data: { isActive: true, deactivatedBy: null, rosterAbsentSince: null },
        }));
      }
      if (plan.clearAbsent.length) {
        await prisma.user.updateMany({
          where: { id: { in: plan.clearAbsent }, orgId },
          data: { rosterAbsentSince: null },
        });
      }
      if (plan.markAbsent.length) {
        await prisma.user.updateMany({
          where: { id: { in: plan.markAbsent }, orgId, rosterAbsentSince: null },
          data: { rosterAbsentSince: stamp },
        });
      }
      let deactivated = 0;
      if (plan.deactivate.length) {
        ({ count: deactivated } = await prisma.user.updateMany({
          where: { id: { in: plan.deactivate }, orgId, isActive: true, ssoExempt: false },
          data: { isActive: false, sessionsValidFrom: stamp, deactivatedBy: actor },
        }));
        // HARD RULE (CLAUDE.md, docs/remember-me.md): the cutoff above without
        // this line is a deprovisioning that does not deprovision — the
        // remembered-device cookie mints a fresh session on the next page load.
        await revokeTrustedDevicesForUsers(plan.deactivate);
      }

      // The run log: one row per person acted on, below zero (no file row
      // describes somebody the file did not contain).
      const rows = [
        ...plan.deactivate.map((id) => ({ id, status: 'DEACTIVATE' as const, message: 'absent from the feed past the grace period' })),
        ...plan.reactivate.map((id) => ({ id, status: 'REACTIVATE' as const, message: 'back in the feed' })),
        ...plan.refused.map((r) => ({
          id: r.id,
          status: 'SKIP' as const,
          message: r.reason === 'last_admin' ? 'not deactivated: last active admin' : 'not deactivated: SSO break-glass account',
        })),
      ];
      if (rows.length) {
        const lowest = await prisma.rosterRowResult.aggregate({ where: { runId: run.id }, _min: { rowNumber: true } });
        const start = Math.min(0, lowest._min.rowNumber ?? 0);
        await prisma.rosterRowResult.createMany({
          data: rows.map((r, i) => ({
            runId: run.id,
            orgId,
            rowNumber: start - 1 - i,
            key: (keys.get(r.id) ?? r.id).slice(0, 255),
            status: r.status,
            message: r.message,
            userId: r.id,
          })),
        });
      }
      if (deactivated || reactivated) {
        await prisma.rosterRun.update({
          where: { id: run.id },
          data: { deactivatedCount: { increment: deactivated }, reactivatedCount: { increment: reactivated } },
        });
      }
      if (deactivated) {
        await logActivity({
          action: 'roster.deprovisioned',
          level: 'warning',
          orgId,
          targetType: 'roster_feed',
          targetId: feed.id,
          detail: `${feed.name ?? feed.id}: deactivated=${deactivated}`.slice(0, 191),
        });
      }
      if (plan.refused.length) {
        const admins = plan.refused.filter((r) => r.reason === 'last_admin').length;
        await logActivity({
          action: 'roster.deprovision_refused',
          level: 'warning',
          orgId,
          targetType: 'roster_feed',
          targetId: feed.id,
          detail: `last_admin=${admins} sso_exempt=${plan.refused.length - admins}`,
        });
      }
      return { deactivated, reactivated };
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

/**
 * The feed's secret, for the transport and nobody else (#1964): the sealed
 * column first, the named environment variable second. A sealed value that no
 * longer opens (NEXTAUTH_SECRET rotated, row copied between environments) fails
 * the run loudly — fetching without the credential would read as an outage at
 * best and, on a misconfigured server, as somebody else's file.
 */
export function resolveFeedSecret(row: { secretEnc: string | null; credentialEnvVar: string | null }): string | null {
  if (row.secretEnc) {
    const secret = open(row.secretEnc, ROSTER_FEED_SECRET_PURPOSE);
    if (secret === null) {
      throw new RosterTransportError('The stored feed secret cannot be decrypted; enter it again.');
    }
    return secret;
  }
  if (row.credentialEnvVar) return process.env[row.credentialEnvVar] || null;
  return null;
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
  secretEnc: true,
  deprovision: true,
  maxDeactivatePercent: true,
  minRowCount: true,
  deprovisionGraceDays: true,
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
  /** Test seam: replace the transport (the e2e suite has no HTTPS server). */
  seams: { fetchFile?: (feed: RosterFeedConfig) => Promise<FeedFile> } = {},
): Promise<RosterIngestResult> {
  // Read the feed outside any tenant scope (there is none yet — the feed row is
  // what says which tenant this is), then bind that org for everything after.
  const row = await runWithOrg(null, () =>
    prisma.rosterFeed.findUnique({ where: { id: feedId }, select: FEED_SELECT }),
  );
  if (!row) throw new Error(`No roster feed ${feedId}`);
  const feed = toFeedConfig(row);

  return runWithOrg(feed.orgId, async () => {
    const result = await ingestRoster(
      feed,
      {
        store: prismaRosterStore(feed),
        loadTarget: loadRosterTarget,
        // Resolved here, at fetch time, so the plaintext lives for one call and
        // never sits on the config object the run log is built from.
        fetchFile:
          seams.fetchFile ??
          ((f) =>
            fetchFeedFile(
              { ...f, secret: resolveFeedSecret(row) },
              // The e2e switch; see FetchFeedOptions.allowInsecureLoopback.
              { allowInsecureLoopback: process.env.ROSTER_FEED_ALLOW_INSECURE_STUB === '1' },
            )),
        deprovision: prismaDeprovisionPort(feed, {
          feedId: row.id,
          deprovision: row.deprovision,
          maxDeactivatePercent: row.maxDeactivatePercent,
          minRowCount: row.minRowCount,
          deprovisionGraceDays: row.deprovisionGraceDays,
        }),
      },
      options,
    );
    if (!options.dryRun) await alertRosterRun({ id: row.id, orgId: row.orgId, name: row.name }, result);
    return result;
  });
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
