// The scheduled roster feed: fetch → parse → diff → dry run → apply, resumable.
//
// WHAT THIS IS (#1965, story #1963)
//   A tenant drops a CSV export of their people on an SFTP server (or serves it
//   over HTTPS) and we turn it into an accurate roster every night, with no
//   human in the loop. The parsing is the easy half. The hard half is the
//   **diff** — which row is new, which changed, which is unchanged and must
//   therefore not be touched at all — and doing it so that a retry after a
//   crash halfway through does not apply anything twice.
//
// WHERE THE PIECES LIVE
//   • `src/lib/importPreview.ts` (#2072) owns the engine and the vocabulary:
//     `runImport({ parse, validate, resolve, apply })`, the shared delimited
//     parser, `RowStatus`/`RowResult`/`ImportReport`. There is no second parser
//     and no second dry-run engine.
//   • THIS module owns what a per-request preview cannot do: the transport, the
//     SHA-256 file-hash no-op, the diff, chunking, and the resume protocol.
//   • `src/lib/rosterIngestStore.ts` owns the Prisma side of those ports —
//     `RosterRun`/`RosterRowResult`, one transaction per chunk, and the
//     org-explicit `runWithOrg()` entry a cron job needs (it has no session, so
//     `withTenantScope` is not available to it).
//
//   Everything here is free of Prisma, `next` and React on purpose: the diff and
//   the resume protocol are the two things that must be pinned by unit tests
//   (`scripts/test/roster-ingest.test.mjs`), and neither of them needs a
//   database to be wrong.
//
// THE FOUR PROPERTIES THIS FILE EXISTS TO GUARANTEE
//   1. **An unchanged file is a no-op.** The file is hashed and compared with
//      the last successful run's hash; equal means "record a no-op and stop".
//   2. **The dry run is honest.** It is the same call with a writer that does
//      not write (`previewWriter`), so the preview is produced by the code that
//      applies. Nothing is planned in an `if (dryRun)` branch.
//   3. **Apply is idempotent.** A run is identified by `(feedId, fileHash)`;
//      re-running an already-succeeded file changes nothing. Even a partial
//      re-run is safe because the plan is re-derived against the live roster:
//      a row that was already written comes back UNCHANGED.
//   4. **Resume means resume after a crash mid-batch.** The checkpoint is a
//      column (`RosterRun.nextChunkIndex`) committed in the SAME transaction as
//      the chunk's writes, not a counter in memory. It is contiguous: it never
//      advances past a chunk that failed, so a failed chunk is re-attempted on
//      the next run instead of being silently skipped.
//
// Deprovisioning is NOT here: `absent` is computed and reported, and #1966 is
// what decides to act on it.

import { createHash } from 'node:crypto';
import {
  DEFAULT_CHUNK_SIZE,
  countRows,
  headerIndex,
  importErrorMessage,
  parseDelimited,
  runImport,
  type ImportReport,
  type ParsedRow,
  type PlannedRow,
  type ResolveResult,
  type RowResult,
  type RowStatus,
  type ValidatedRow,
} from './importPreview';
import { planFieldUpdates } from './externalSyncPolicy';
import { assertPublicHttpsUrl } from './ssrfGuard';

// ── Feed configuration ───────────────────────────────────────────────────────

export const ROSTER_TRANSPORTS = ['HTTPS', 'SFTP'] as const;
export type RosterTransport = (typeof ROSTER_TRANSPORTS)[number];

/**
 * Which column identifies a person.
 *
 * EMAIL is the obvious choice and the wrong one for any tenant whose people
 * ever change their address: with e-mail as the key, one person renaming their
 * mailbox is indistinguishable from a leaver plus a joiner — and #1966 would
 * deprovision the leaver. EXTERNAL_ID (the HR system's own personnel number) is
 * what makes an e-mail change readable as an update.
 */
export const ROSTER_KEY_FIELDS = ['EMAIL', 'EXTERNAL_ID'] as const;
export type RosterKeyField = (typeof ROSTER_KEY_FIELDS)[number];

export const ROSTER_RUN_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'NOOP'] as const;
export type RosterRunStatus = (typeof ROSTER_RUN_STATUSES)[number];

/** Profile columns a feed may carry, beyond the identity ones. */
export const ROSTER_PROFILE_FIELDS = ['fullName', 'phone', 'university', 'department'] as const;
export type RosterProfileField = (typeof ROSTER_PROFILE_FIELDS)[number];

/** Our field name → the header the tenant's export happens to use. */
export interface RosterColumnMap {
  email?: string;
  externalId?: string;
  fullName?: string;
  phone?: string;
  university?: string;
  department?: string;
}

export interface RosterFeedConfig {
  id: string;
  orgId: string;
  name?: string;
  transport: RosterTransport;
  /** HTTPS transport: the file's URL. Checked by `assertPublicHttpsUrl()`. */
  url?: string | null;
  /** SFTP transport. */
  sftpHost?: string | null;
  sftpPort?: number | null;
  sftpUsername?: string | null;
  sftpPath?: string | null;
  /**
   * The pinned host key fingerprint (#1964). No fingerprint, no connection: a
   * feed that trusts whatever key answers is a feed that can be handed someone
   * else's roster.
   */
  sftpHostKeyFingerprint?: string | null;
  /**
   * NAME of the environment variable holding the SFTP secret. The secret itself
   * is never stored in the database — the row holds only the name of the place
   * to read it from.
   */
  credentialEnvVar?: string | null;
  /** Force a delimiter instead of sniffing it (`;` for a German Excel export). */
  delimiter?: string | null;
  keyField: RosterKeyField;
  columnMap: RosterColumnMap;
  /**
   * The tenant declaring "the feed is the record of truth for these people".
   * When false, the feed fills gaps but never overwrites a value a human typed
   * — the same policy SSO sync follows (src/lib/externalSyncPolicy.ts).
   */
  authoritative: boolean;
  chunkSize?: number | null;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** One row of the feed, after column mapping. */
export interface RosterFeedRow {
  email: string | null;
  externalId: string | null;
  profile: Partial<Record<RosterProfileField, string>>;
}

/** The fields an apply may write on a user. */
export interface RosterWritableFields {
  email?: string;
  externalId?: string;
  fullName?: string;
  phone?: string;
  university?: string;
  department?: string;
}

/** What the diff decided for one row: the input, the writes, and what it left alone. */
export interface RosterRowPlan {
  feed: RosterFeedRow;
  changes: RosterWritableFields;
  /** Fields the feed disagreed with but was not authoritative enough to write. */
  withheld: string[];
}

export type RosterPlannedRow = PlannedRow<RosterRowPlan>;
export type RosterRowResultData = RowResult<RosterRowPlan>;

/** A person as the roster currently holds them. */
export interface RosterTargetRow {
  id: string;
  email: string;
  externalId?: string | null;
  fullName?: string | null;
  phone?: string | null;
  university?: string | null;
  department?: string | null;
}

// ── Transport ────────────────────────────────────────────────────────────────

export class RosterTransportError extends Error {}
export class RosterIngestError extends Error {}

/** 8 MiB. A roster is text; anything larger is a mistake or an attack. */
export const MAX_FEED_BYTES = 8 * 1024 * 1024;

export interface FeedFile {
  text: string;
  /** SHA-256 of the raw bytes, hex. The no-op check compares this. */
  fileHash: string;
  bytes: number;
  /** Where it came from, for the run log. Never carries a credential. */
  source: string;
}

export function hashFeedBytes(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

/** Normalise a fingerprint for comparison: hex pairs, lower case, no separators. */
export function normalizeHostKeyFingerprint(raw: string): string {
  return raw.trim().toLowerCase().replace(/^(sha256|md5):/, '').replace(/[\s:]/g, '');
}

/**
 * Throw unless the key the server presented is the key the tenant pinned
 * (#1964). Separated from the SFTP client so the comparison itself is
 * unit-tested — "we compared the fingerprints" is the kind of claim that is
 * usually true right up until someone reorders an argument.
 */
export function assertHostKeyFingerprint(presented: string, pinned: string | null | undefined): void {
  if (!pinned || !pinned.trim()) {
    throw new RosterTransportError(
      'This feed has no pinned SFTP host key fingerprint; refusing to connect (#1964).',
    );
  }
  if (normalizeHostKeyFingerprint(presented) !== normalizeHostKeyFingerprint(pinned)) {
    throw new RosterTransportError(
      'The SFTP host key does not match the fingerprint pinned for this feed; refusing to connect.',
    );
  }
}

export interface FetchFeedOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}

/**
 * Download the feed file and hash it.
 *
 * HTTPS goes through `assertPublicHttpsUrl()` — the URL is tenant-supplied and
 * fetched from the server's network position, where `https://127.0.0.1:3306`
 * and the cloud metadata service are both reachable (#893).
 *
 * SFTP is declared here but not yet wired: it needs an SFTP client dependency,
 * which is its own reviewed change. The host-key pin it will use is implemented
 * and tested above, and the transport refuses loudly rather than falling back
 * to anything less safe.
 */
export async function fetchFeedFile(
  feed: RosterFeedConfig,
  options: FetchFeedOptions = {},
): Promise<FeedFile> {
  const maxBytes = options.maxBytes ?? MAX_FEED_BYTES;

  if (feed.transport === 'SFTP') {
    // Fail closed, and say exactly what is missing. The alternative — quietly
    // treating an unreachable feed as an empty roster — would report every
    // person in the tenant as `absent`.
    if (!feed.sftpHostKeyFingerprint?.trim()) {
      throw new RosterTransportError(
        'This feed has no pinned SFTP host key fingerprint; refusing to connect (#1964).',
      );
    }
    throw new RosterTransportError(
      'The SFTP transport is not wired yet: it needs an SFTP client dependency (#1965 follow-up). ' +
        'Use the HTTPS transport, or run the file through scripts/import-csv.mjs.',
    );
  }

  const url = (feed.url ?? '').trim();
  if (!url) throw new RosterTransportError('This feed has no URL configured.');
  const safeUrl = await assertPublicHttpsUrl(url);

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(safeUrl.toString(), {
    headers: { accept: 'text/csv, text/plain;q=0.9, */*;q=0.1' },
    redirect: 'error', // a redirect would escape the address check above
  });
  if (!response.ok) {
    throw new RosterTransportError(`The feed URL answered ${response.status}.`);
  }
  const declared = Number(response.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RosterTransportError(`The feed is larger than the ${maxBytes}-byte cap.`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new RosterTransportError(`The feed is larger than the ${maxBytes}-byte cap.`);
  }

  return {
    text: Buffer.from(buffer).toString('utf8'),
    fileHash: hashFeedBytes(buffer),
    bytes: buffer.byteLength,
    // Host and path only: a query string can carry a token.
    source: `${safeUrl.origin}${safeUrl.pathname}`,
  };
}

// ── Parse + validate ─────────────────────────────────────────────────────────

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function parseRoster(text: string, feed: RosterFeedConfig) {
  return parseDelimited(text, { delimiter: feed.delimiter ?? undefined });
}

/** The feed's own identity string for a row (normalised for matching). */
export function rosterRowKey(feed: RosterFeedConfig, row: RosterFeedRow): string {
  const raw = feed.keyField === 'EXTERNAL_ID' ? row.externalId : row.email;
  return (raw ?? '').trim().toLowerCase();
}

function targetKey(feed: RosterFeedConfig, target: RosterTargetRow): string {
  const raw = feed.keyField === 'EXTERNAL_ID' ? target.externalId : target.email;
  return (raw ?? '').trim().toLowerCase();
}

/**
 * Map one parsed row onto a `RosterFeedRow`, or reject it.
 *
 * A row is rejected — never guessed at — when it has no usable e-mail (the
 * account we create or update is keyed on one) or no key value.
 */
export function validateRosterRow(
  feed: RosterFeedConfig,
  parsed: ParsedRow,
  header: string[],
): ValidatedRow<RosterFeedRow> {
  const map = feed.columnMap ?? {};
  const pick = (column: string | undefined): string => {
    if (!column) return '';
    const index = headerIndex(header, column);
    if (index < 0) return '';
    return (parsed.values[index] ?? '').trim();
  };

  const email = pick(map.email).toLowerCase();
  const externalId = pick(map.externalId);
  const profile: Partial<Record<RosterProfileField, string>> = {};
  for (const field of ROSTER_PROFILE_FIELDS) {
    const value = pick(map[field]);
    if (value) profile[field] = value;
  }

  const row: RosterFeedRow = { email: email || null, externalId: externalId || null, profile };
  const key = rosterRowKey(feed, row);

  if (feed.keyField === 'EXTERNAL_ID' && !externalId) {
    return { ok: false, row: parsed.row, key: email, status: 'ERROR', reason: 'missing external id' };
  }
  if (!email || !EMAIL_RE.test(email)) {
    return { ok: false, row: parsed.row, key: key || email, status: 'ERROR', reason: 'invalid email' };
  }
  return { ok: true, row: parsed.row, key, value: row };
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export interface RosterDiff extends ResolveResult<RosterRowPlan> {
  /** The target rows behind `absent`, for #1966's benefit. */
  absentRows: RosterTargetRow[];
}

/**
 * Decide, for every valid feed row, whether it is a CREATE, an UPDATE, an
 * UNCHANGED or a SKIP — and which of the target's people the feed never
 * mentioned.
 *
 * Pure. This is the function the whole task is really about, so it is the one
 * with the most assertions behind it.
 */
export function diffRoster(
  feed: RosterFeedConfig,
  rows: { row: number; key: string; value: RosterFeedRow }[],
  current: RosterTargetRow[],
): RosterDiff {
  const byKey = new Map<string, RosterTargetRow>();
  const byEmail = new Map<string, RosterTargetRow>();
  for (const target of current) {
    const key = targetKey(feed, target);
    if (key) byKey.set(key, target);
    const email = (target.email ?? '').trim().toLowerCase();
    if (email) byEmail.set(email, target);
  }

  const plan: RosterPlannedRow[] = [];
  const seenKeys = new Set<string>();
  const matchedTargetIds = new Set<string>();

  for (const { row, key, value } of rows) {
    // Two rows for the same person in one file: the first wins, and the second
    // is reported rather than silently applied on top of it.
    if (seenKeys.has(key)) {
      plan.push({
        row,
        key,
        status: 'SKIP',
        reason: 'duplicate key in feed',
        value: { feed: value, changes: {}, withheld: [] },
      });
      continue;
    }
    seenKeys.add(key);

    let target = byKey.get(key);
    let adopted = false;
    if (!target && feed.keyField === 'EXTERNAL_ID' && value.email) {
      // First run against people who predate the feed: they have no external id
      // yet, so match them by e-mail once and stamp the id in this same update.
      target = byEmail.get(value.email);
      adopted = target !== undefined;
    }

    const incoming: RosterWritableFields = {
      ...(value.email ? { email: value.email } : {}),
      ...(value.externalId ? { externalId: value.externalId } : {}),
      ...value.profile,
    };

    if (!target) {
      plan.push({
        row,
        key,
        status: 'CREATE',
        value: { feed: value, changes: incoming, withheld: [] },
        changed: Object.keys(incoming),
      });
      continue;
    }

    matchedTargetIds.add(target.id);
    const currentFields: Required<RosterWritableFields> = {
      email: target.email ?? '',
      externalId: target.externalId ?? '',
      fullName: target.fullName ?? '',
      phone: target.phone ?? '',
      university: target.university ?? '',
      department: target.department ?? '',
    };
    const { changes, changed, withheld } = planFieldUpdates(currentFields, incoming, {
      authoritative: feed.authoritative,
    });

    if (changed.length === 0) {
      // Not written at all — the point of the diff. An unchanged row costs one
      // row in the run log and nothing else.
      plan.push({
        row,
        key,
        status: 'UNCHANGED',
        targetId: target.id,
        value: { feed: value, changes: {}, withheld },
        ...(withheld.length > 0 ? { reason: `left alone: ${withheld.join(', ')}` } : {}),
      });
      continue;
    }

    plan.push({
      row,
      key,
      status: 'UPDATE',
      targetId: target.id,
      changed,
      value: { feed: value, changes, withheld },
      ...(adopted ? { reason: 'matched by email, external id adopted' } : {}),
    });
  }

  const absentRows = current.filter((target) => {
    if (matchedTargetIds.has(target.id)) return false;
    const key = targetKey(feed, target);
    return !key || !seenKeys.has(key);
  });

  return {
    plan,
    absent: absentRows.map((target) => targetKey(feed, target) || target.email),
    absentRows,
  };
}

// ── Apply ────────────────────────────────────────────────────────────────────

/**
 * The write side of one chunk. The store implements it inside a transaction;
 * `previewWriter` implements it as nothing at all, which is the entire
 * difference between a dry run and a real one.
 */
export interface RosterRowWriter {
  create(row: RosterPlannedRow): Promise<string | null>;
  update(row: RosterPlannedRow): Promise<string | null>;
}

/** The dry-run writer: same plan, same report, no writes. */
export const previewWriter: RosterRowWriter = {
  async create() {
    return null;
  },
  async update(row) {
    return row.targetId ?? null;
  },
};

/**
 * Apply the planned rows of one chunk through `writer` and report each outcome.
 *
 * A row that throws is recorded as ERROR and the chunk continues — one bad row
 * must not cost the other ninety-nine. A failure the *transaction* cannot
 * survive propagates instead, and `runImport` marks the whole chunk ERROR after
 * it has rolled back (#1432: no half-written chunk, ever).
 */
export async function applyPlannedRows(
  rows: RosterPlannedRow[],
  writer: RosterRowWriter,
): Promise<RosterRowResultData[]> {
  const results: RosterRowResultData[] = [];
  for (const row of rows) {
    if (row.status === 'UNCHANGED' || row.status === 'SKIP') {
      results.push({
        row: row.row,
        key: row.key,
        status: row.status,
        targetId: row.targetId ?? null,
        ...(row.reason ? { reason: row.reason } : {}),
        value: row.value,
      });
      continue;
    }
    try {
      const targetId =
        row.status === 'CREATE' ? await writer.create(row) : await writer.update(row);
      results.push({
        row: row.row,
        key: row.key,
        status: row.status,
        targetId,
        changed: row.changed ?? [],
        ...(row.reason ? { reason: row.reason } : {}),
        value: row.value,
      });
    } catch (error) {
      results.push({
        row: row.row,
        key: row.key,
        status: 'ERROR',
        reason: importErrorMessage(error),
        value: row.value,
      });
    }
  }
  return results;
}

// ── Persistence ports ────────────────────────────────────────────────────────

export interface RosterRunRecord {
  id: string;
  feedId: string;
  orgId: string;
  fileHash: string;
  dryRun: boolean;
  status: RosterRunStatus;
  /**
   * The resume checkpoint: the index of the first chunk that has NOT been
   * committed. Written in the same transaction as the chunk it describes, and
   * contiguous — it never advances past a chunk that failed.
   */
  nextChunkIndex: number;
  startedAt: Date;
}

export interface RosterStore {
  /** The last run of this feed that finished cleanly — its hash is the no-op check. */
  lastSuccessfulRun(feedId: string): Promise<RosterRunRecord | null>;
  /** The run for this exact `(feedId, fileHash, dryRun)`, if one exists. */
  findRun(feedId: string, fileHash: string, dryRun: boolean): Promise<RosterRunRecord | null>;
  startRun(input: {
    feedId: string;
    orgId: string;
    fileHash: string;
    dryRun: boolean;
    rowCount: number;
    source: string;
  }): Promise<RosterRunRecord>;
  /** Re-open a stale RUNNING or a FAILED run so it can be resumed. */
  reopenRun(run: RosterRunRecord): Promise<RosterRunRecord>;
  /** Record that the file had not changed and nothing was done. */
  recordNoopRun(input: {
    feedId: string;
    orgId: string;
    fileHash: string;
    source: string;
  }): Promise<RosterRunRecord>;
  /** Row results a previous attempt already committed (so a resumed report is whole). */
  recordedRows(runId: string): Promise<RosterRowResultData[]>;
  /**
   * ONE transaction: the chunk's user writes, its per-row results, and the
   * checkpoint. All three commit together or none of them do.
   */
  commitChunk(input: {
    run: RosterRunRecord;
    chunkIndex: number;
    rows: RosterPlannedRow[];
  }): Promise<RosterRowResultData[]>;
  finishRun(input: {
    run: RosterRunRecord;
    status: RosterRunStatus;
    counts: Record<RowStatus, number>;
    absent: string[];
    error?: string | null;
  }): Promise<void>;
}

// ── The run ──────────────────────────────────────────────────────────────────

export type RosterIngestOutcome =
  | 'APPLIED'
  | 'NOOP_UNCHANGED_FILE'
  | 'ALREADY_APPLIED'
  | 'LOCKED';

export interface RosterIngestResult {
  outcome: RosterIngestOutcome;
  feedId: string;
  fileHash: string;
  dryRun: boolean;
  run: RosterRunRecord | null;
  report: ImportReport<RosterRowPlan> | null;
  absent: string[];
  resumedFromChunk: number;
  message?: string;
}

export interface RosterIngestDeps {
  store: RosterStore;
  /** The roster as it stands, for this feed's org only. */
  loadTarget: (feed: RosterFeedConfig) => Promise<RosterTargetRow[]>;
  fetchFile?: (feed: RosterFeedConfig) => Promise<FeedFile>;
}

export interface RosterIngestOptions {
  dryRun?: boolean;
  chunkSize?: number;
  now?: Date;
  /** A RUNNING run older than this is presumed dead and may be resumed. */
  staleRunMs?: number;
}

/** 30 minutes. Longer than any healthy run, shorter than the gap to the next one. */
export const DEFAULT_STALE_RUN_MS = 30 * 60 * 1000;

/**
 * Ingest one feed. Callable from a route handler and from a scheduled job — it
 * takes an explicit `orgId` (through the feed) rather than a session, because a
 * cron job has none.
 *
 * The caller is responsible for binding the tenant context first; the Prisma
 * store does it with `runWithOrg(feed.orgId, …)` (src/lib/rosterIngestStore.ts).
 */
export async function ingestRoster(
  feed: RosterFeedConfig,
  deps: RosterIngestDeps,
  options: RosterIngestOptions = {},
): Promise<RosterIngestResult> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? new Date();
  const fetchFile = deps.fetchFile ?? ((f: RosterFeedConfig) => fetchFeedFile(f));
  const file = await fetchFile(feed);

  const base = { feedId: feed.id, fileHash: file.fileHash, dryRun };

  // (1) An unchanged file must not churn the roster.
  if (!dryRun) {
    const last = await deps.store.lastSuccessfulRun(feed.id);
    if (last && last.fileHash === file.fileHash) {
      const run = await deps.store.recordNoopRun({
        feedId: feed.id,
        orgId: feed.orgId,
        fileHash: file.fileHash,
        source: file.source,
      });
      return {
        ...base,
        outcome: 'NOOP_UNCHANGED_FILE',
        run,
        report: null,
        absent: [],
        resumedFromChunk: 0,
        message: 'The file is byte-identical to the last successful run.',
      };
    }
  }

  // (2) Idempotency and resume, both decided by `(feedId, fileHash)`.
  const existing = await deps.store.findRun(feed.id, file.fileHash, dryRun);
  let run: RosterRunRecord;
  if (existing) {
    if (existing.status === 'SUCCEEDED' && !dryRun) {
      return {
        ...base,
        outcome: 'ALREADY_APPLIED',
        run: existing,
        report: null,
        absent: [],
        resumedFromChunk: existing.nextChunkIndex,
        message: 'This exact file has already been applied for this feed.',
      };
    }
    const staleAfter = options.staleRunMs ?? DEFAULT_STALE_RUN_MS;
    const age = now.getTime() - existing.startedAt.getTime();
    if (existing.status === 'RUNNING' && age < staleAfter) {
      // Another worker is on it. Two workers applying the same chunk is exactly
      // the double-apply this task exists to prevent.
      return {
        ...base,
        outcome: 'LOCKED',
        run: existing,
        report: null,
        absent: [],
        resumedFromChunk: existing.nextChunkIndex,
        message: 'A run for this file is already in progress.',
      };
    }
    run = await deps.store.reopenRun(existing);
  } else {
    const parsedRowCount = parseRoster(file.text, feed).rows.length;
    run = await deps.store.startRun({
      feedId: feed.id,
      orgId: feed.orgId,
      fileHash: file.fileHash,
      dryRun,
      rowCount: parsedRowCount,
      source: file.source,
    });
  }

  const resumedFromChunk = run.nextChunkIndex;
  let absent: string[] = [];

  try {
    const report = await runImport<RosterFeedRow, RosterRowPlan>({
      parse: () => parseRoster(file.text, feed),
      validate: (parsed, header) => validateRosterRow(feed, parsed, header),
      resolve: async (rows) => {
        const diff = diffRoster(feed, rows, await deps.loadTarget(feed));
        absent = diff.absent;
        return { plan: diff.plan, absent: diff.absent };
      },
      apply: (rows, context) =>
        deps.store.commitChunk({ run, chunkIndex: context.chunkIndex, rows }),
      chunkSize: options.chunkSize ?? feed.chunkSize ?? DEFAULT_CHUNK_SIZE,
      dryRun,
      startChunk: resumedFromChunk,
    });

    // Rows an earlier attempt committed are part of this file's outcome even
    // though this attempt skipped their chunks.
    const merged =
      resumedFromChunk > 0
        ? mergeRecordedRows(await deps.store.recordedRows(run.id), report)
        : report;

    const status: RosterRunStatus = merged.counts.ERROR > 0 ? 'FAILED' : 'SUCCEEDED';
    await deps.store.finishRun({ run, status, counts: merged.counts, absent });
    return {
      ...base,
      outcome: 'APPLIED',
      run: { ...run, status },
      report: merged,
      absent,
      resumedFromChunk,
    };
  } catch (error) {
    // The run itself came apart (the transport, the store, the parse). Record it
    // as FAILED so the checkpoint survives and the next run resumes rather than
    // starting the file over.
    await deps.store.finishRun({
      run,
      status: 'FAILED',
      counts: countRows([]),
      absent,
      error: importErrorMessage(error),
    });
    throw error instanceof RosterIngestError
      ? error
      : new RosterIngestError(importErrorMessage(error));
  }
}

/** Fold rows a previous attempt committed into this attempt's report. */
export function mergeRecordedRows(
  recorded: RosterRowResultData[],
  report: ImportReport<RosterRowPlan>,
): ImportReport<RosterRowPlan> {
  const fresh = new Set(report.rows.map((r) => r.row));
  const rows = [...report.rows, ...recorded.filter((r) => !fresh.has(r.row))].sort(
    (a, b) => a.row - b.row,
  );
  return { ...report, rows, counts: countRows(rows) };
}
