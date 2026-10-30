// Queued bulk candidate import on /api/v1 (#3015) — the inbound half of the
// async export (#3002).
//
// POST /api/v1/imports/candidates stores up to IMPORT_ROW_CAP rows on an
// `ApiImport` row and enqueues `api.import.candidates`; the worker runs them
// through THE import engine, `runImport({ parse, validate, resolve, apply })`
// (src/lib/importPreview.ts, CLAUDE.md § One import engine). There is no
// second parser and no second dry-run engine: `parse` hands the engine the
// submitted rows as a one-column table, and a dry run is the same call with an
// `apply` that does not write.
//
// Per row, the rules of the single POST /api/v1/candidates:
//   - `createCandidateSchema` and the skill limits (ERROR with the reason);
//   - an e-mail already in use in this product's world → SKIP
//     `duplicate_email` (the match's id only when it is in the key's own org —
//     another tenant's account is not named); twice in one batch → SKIP
//     `duplicate_in_batch`;
//   - a look-alike by the shared duplicate rule (the org's pool loaded ONCE,
//     `loadDuplicatePool` + `rankDuplicates`) → SKIP `possible_duplicate` with
//     the matches, unless the row says `allowPossibleDuplicate: true`.
// A row is one `user.create` (chunk size 1): it is created whole or not at all,
// and one failing row never takes its neighbours down with it.
//
// At-least-once: the job may run again after an attempt died mid-way. Rows the
// dead attempt created are then found by their e-mail and reported as SKIP
// `duplicate_email` naming their own id — nothing is created twice.
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { createUser } from '@/lib/userCreate';
import { runWithOrg } from '@/lib/orgContext';
import { entitled } from '@/lib/entitlements';
import { apiKeyStatus, parseScopes } from '@/lib/apiScopes';
import { createCandidateSchema } from '@/lib/api/v1Candidates';
import { blockingSkillIssue, parseSkills } from '@/lib/skills';
import { loadDuplicatePool, rankDuplicates } from '@/lib/duplicateDetection';
import { emailTakenInWorld, findUsersInWorldByEmails, worldOfOrg } from '@/lib/userWorld';
import { runImport, type ImportHooks, type RowStatus } from '@/lib/importPreview';
import { logActivity } from '@/lib/activity';

/** Rows one request may carry. */
export const IMPORT_ROW_CAP = 500;
/** The request body limit of the bulk route (the single-record floor is 64 KB). */
export const IMPORT_BODY_MAX = 1024 * 1024;
/** A finished import's report stays readable this long; then the row is deleted. */
export const IMPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Imports a key may have queued or running at once (409 `limit_reached`). */
export const MAX_OPEN_IMPORTS_PER_KEY = 2;

export const importRequestSchema = z
  .object({
    candidates: z.array(z.unknown()).min(1).max(IMPORT_ROW_CAP),
    dryRun: z.boolean().optional(),
  })
  .strict();

type Candidate = Omit<z.infer<typeof createCandidateSchema>, 'skills'> & { skills?: string[] };
type Match = { id: string; signals: string[]; score?: number };
type Planned = Candidate & { matches?: Match[] };

/** One line of the report GET /api/v1/imports/{id} answers. */
export interface ImportReportRow {
  /** 1-based position in the submitted `candidates` array. */
  row: number;
  /** The row's e-mail, or `row <n>` when it has none. */
  key: string;
  status: RowStatus;
  reason?: string;
  /** The created candidate's id. */
  id?: string;
  matches?: Match[];
}

export interface ImportOutcome {
  dryRun: boolean;
  total: number;
  counts: Record<RowStatus, number>;
  rows: ImportReportRow[];
}

/** The engine's hooks for one batch of the org's candidates. */
export function candidateImportHooks(orgId: string, rows: unknown[], dryRun: boolean, signal?: AbortSignal): ImportHooks<Candidate, Planned> {
  return {
    dryRun,
    chunkSize: 1,
    parse: () => ({
      header: ['candidate'],
      rows: rows.map((value, i) => ({ row: i + 1, values: [JSON.stringify(value ?? null)] })),
      delimiter: ',',
    }),
    validate: (row) => {
      let value: unknown;
      try {
        value = JSON.parse(row.values[0]);
      } catch {
        value = null;
      }
      const email = (value as { email?: unknown } | null)?.email;
      const key = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : `row ${row.row}`;
      const parsed = createCandidateSchema.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue.path.join('.') || (issue.code === 'unrecognized_keys' ? issue.keys.join(',') : '');
        return { ok: false, row: row.row, key, status: 'ERROR', reason: `${path ? `${path}: ` : ''}${issue.message}`.slice(0, 300) };
      }
      let skills: string[] | undefined;
      if (parsed.data.skills !== undefined) {
        const split = parseSkills(parsed.data.skills);
        const blocking = blockingSkillIssue(split.issues);
        if (blocking) return { ok: false, row: row.row, key, status: 'ERROR', reason: `skills: ${blocking.code === 'too_many' ? 'too many skills' : 'a skill is too long'}` };
        skills = split.skills;
      }
      return { ok: true, row: row.row, key, value: { ...parsed.data, skills } };
    },
    resolve: async (valid) => {
      const world = await worldOfOrg(orgId);
      const existing = await findUsersInWorldByEmails(
        valid.map((v) => v.value.email),
        world,
        { id: true, orgId: true, email: true },
      );
      const taken = new Map<string, Match[]>();
      for (const u of existing) {
        const list = taken.get(u.email) ?? [];
        if (u.orgId === orgId) list.push({ id: u.id, signals: ['email'] });
        taken.set(u.email, list);
      }
      const pool = await loadDuplicatePool(orgId);
      const seen = new Set<string>();
      const plan = valid.map(({ row, key, value }) => {
        if (taken.has(value.email)) return { row, key, status: 'SKIP' as const, reason: 'duplicate_email', value: { ...value, matches: taken.get(value.email) } };
        if (seen.has(value.email)) return { row, key, status: 'SKIP' as const, reason: 'duplicate_in_batch', value };
        seen.add(value.email);
        if (!value.allowPossibleDuplicate) {
          const matches = rankDuplicates({ fullName: value.fullName, email: value.email, university: value.university }, pool);
          if (matches.length > 0) {
            return {
              row,
              key,
              status: 'SKIP' as const,
              reason: 'possible_duplicate',
              value: { ...value, matches: matches.slice(0, 5).map((m) => ({ id: m.id, signals: m.signals, score: m.score })) },
            };
          }
        }
        return { row, key, status: 'CREATE' as const, value };
      });
      return { plan, absent: [] };
    },
    apply: async (chunk, { dryRun: dry }) => {
      if (signal?.aborted) throw new Error('api.import.candidates aborted');
      const out = [];
      for (const p of chunk) {
        if (p.status !== 'CREATE' || dry) {
          out.push({ row: p.row, key: p.key, status: p.status, reason: p.reason, value: p.value });
          continue;
        }
        const c = p.value;
        // The batch lookup ran before the first row was written; a concurrent
        // writer (another import, the UI) may have taken the address since.
        if (await emailTakenInWorld(c.email, await worldOfOrg(orgId))) {
          out.push({ row: p.row, key: p.key, status: 'SKIP' as const, reason: 'duplicate_email', value: c });
          continue;
        }
        const created = await createUser(prisma, {
          data: {
            email: c.email,
            fullName: c.fullName,
            university: c.university ?? null,
            department: c.department ?? null,
            graduationYear: c.graduationYear ?? null,
            ...(c.skills ? { skills: c.skills } : {}),
            // A password nobody knows, like a CSV-imported account: it is claimed through a reset.
            password: await bcrypt.hash(randomBytes(18).toString('hex'), 10),
            role: 'MENTEE',
            orgId,
          },
          select: { id: true },
        }, { source: 'api_import' });
        out.push({ row: p.row, key: p.key, status: 'CREATE' as const, targetId: created.id, value: c });
      }
      return out;
    },
  };
}

/** Run one batch through the engine; the report carries no submitted field but the e-mail key. */
export async function importCandidates(orgId: string, rows: unknown[], dryRun: boolean, signal?: AbortSignal): Promise<ImportOutcome> {
  const report = await runImport(candidateImportHooks(orgId, rows, dryRun, signal));
  return {
    dryRun: report.dryRun,
    total: report.total,
    counts: report.counts,
    rows: report.rows.map((r) => ({
      row: r.row,
      key: r.key,
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.targetId ? { id: r.targetId } : {}),
      ...(r.value?.matches ? { matches: r.value.matches } : {}),
    })),
  };
}

/**
 * The `api.import.candidates` handler. A DONE or FAILED row is left alone; the
 * key is asked again (live, `candidates:write`, entitled) before anything is
 * written, and the last failed attempt marks the import FAILED rather than
 * leaving it RUNNING for the integration to poll forever.
 */
export async function runApiImport(
  importId: string,
  ctx: { signal: AbortSignal; attempt: number; maxAttempts: number },
): Promise<{ created: number; skipped: number; errors: number; ignored: number }> {
  const row = await runWithOrg(null, () =>
    prisma.apiImport.findUnique({ where: { id: importId }, select: { id: true, orgId: true, apiKeyId: true, kind: true, dryRun: true, status: true, input: true } }),
  );
  if (!row || (row.status !== 'PENDING' && row.status !== 'RUNNING')) return { created: 0, skipped: 0, errors: 0, ignored: 1 };

  return runWithOrg(row.orgId, async () => {
    const claimed = await prisma.apiImport.updateMany({
      where: { id: row.id, orgId: row.orgId, status: { in: ['PENDING', 'RUNNING'] } },
      data: { status: 'RUNNING' },
    });
    if (claimed.count === 0) return { created: 0, skipped: 0, errors: 0, ignored: 1 };

    const finish = (data: { status: 'DONE' | 'FAILED'; report?: string; error?: string }) =>
      prisma.apiImport.updateMany({
        where: { id: row.id, orgId: row.orgId, status: 'RUNNING' },
        data: { ...data, input: null, finishedAt: new Date() },
      });

    if (row.kind !== 'candidates' || !row.input || !(await keyMayWrite(row.apiKeyId, row.orgId))) {
      await finish({ status: 'FAILED', error: 'key_inactive' });
      return { created: 0, skipped: 0, errors: 0, ignored: 1 };
    }

    try {
      const outcome = await importCandidates(row.orgId, JSON.parse(row.input) as unknown[], row.dryRun, ctx.signal);
      await finish({ status: 'DONE', report: JSON.stringify(outcome) });
      await logActivity({
        action: row.dryRun ? 'api.import.candidates.dry_run' : 'api.import.candidates',
        targetType: 'api_import',
        targetId: row.id,
        detail: `api key ${row.apiKeyId} · ${outcome.counts.CREATE} created, ${outcome.counts.SKIP} skipped, ${outcome.counts.ERROR} errors`,
        orgId: row.orgId,
      });
      return { created: outcome.counts.CREATE, skipped: outcome.counts.SKIP, errors: outcome.counts.ERROR, ignored: 0 };
    } catch (error) {
      if (ctx.attempt >= ctx.maxAttempts) await finish({ status: 'FAILED', error: 'run_failed' });
      throw error;
    }
  });
}

async function keyMayWrite(apiKeyId: string, orgId: string): Promise<boolean> {
  const key = await prisma.apiKey.findFirst({ where: { id: apiKeyId, orgId }, select: { scopes: true, expiresAt: true, revokedAt: true } });
  if (!key || apiKeyStatus(key) !== 'active' || !parseScopes(key.scopes).includes('candidates:write')) return false;
  return entitled(orgId, 'INTEGRATIONS_API');
}

/** The status resource. `report` only once the import is DONE. */
export function serializeImport(row: {
  id: string;
  kind: string;
  dryRun: boolean;
  status: string;
  total: number;
  report: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  expiresAt: Date;
}) {
  const outcome = row.report ? (JSON.parse(row.report) as ImportOutcome) : null;
  return {
    id: row.id,
    kind: row.kind,
    dryRun: row.dryRun,
    status: row.status,
    total: row.total,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
    ...(outcome ? { counts: outcome.counts, rows: outcome.rows } : {}),
  };
}

/** Nightly: imports past `expiresAt`. Returns how many went. */
export async function purgeExpiredImports(now: Date = new Date()): Promise<number> {
  const r = await runWithOrg(null, () => prisma.apiImport.deleteMany({ where: { expiresAt: { lt: now } } }));
  return r.count;
}
