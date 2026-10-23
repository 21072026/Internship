// Mid-programme migration (#2073) — the database half. Four sheets, in the
// order their rows depend on each other: people → pairs → stage history →
// interactions. Each sheet is one `runImport` (src/lib/importPreview.ts, the
// engine of #2072) with the rules of src/lib/migration/migrationRules.ts as
// its validate and the bulk lookups below as its resolve. A dry run is the
// same call with a writer that does not write.
//
// ACROSS SHEETS
//   A later sheet names people and pairs an earlier sheet only PLANS to create,
//   so the plan is carried forward in `ctx` (who exists or will, which pairs
//   exist or will). In a dry run a planned row has no id yet and is accepted
//   as a reference; in the real run each sheet is applied before the next one
//   is resolved, so the ids are real by the time they are needed.
//
// WHAT IS NEVER DONE HERE
//   • No mail, no notification, no webhook. Accounts get a random password the
//     person never sees; inviting them is a separate, deliberate step (#2070).
//   • No pair is made ACTIVE for a mentee who already has an active mentor
//     (src/lib/activeMentorship.ts, #419) — re-asked inside the write's own
//     transaction, not only in the plan.
//   • No one from another organization is touched or paired: an address that
//     holds an account in another tenant is reported, not linked.
//   • Every created row carries the importing admin's org (#678).

import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'crypto';
import { prisma } from '@/lib/prisma';
import { runImport, type ImportReport, type PlannedRow, type RowResult } from '@/lib/importPreview';
import { findActiveMentorship } from '@/lib/activeMentorship';
import { resolvePipelineStages, startStageKey } from '@/lib/pipelineStages';
import { worldOfOrg, worldUserWhere } from '@/lib/userWorld';
import { sameTenant } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { acquireLease, releaseLease, replicaId } from '@/lib/jobs/lease';
// The store is passed in, not left to `lease.ts`'s lazy `import('./leaseStore')`:
// the Playwright spec runner transforms static imports only, so under it that
// dynamic import fails, the lease reads as held, and the run is refused (#3145).
import { prismaLeaseStore } from '@/lib/jobs/leaseStore';
import { stageTrialWindow } from '@/lib/trialWindow';
import type { Locale } from '@/i18n/config';
import {
  interactionKey,
  invalidStageTargets,
  mappedTable,
  orderHistory,
  validateHistory,
  validateInteraction,
  validatePair,
  validatePerson,
  type ColumnMapping,
  type HistoryRow,
  type InteractionRow,
  type PairRow,
  type PersonRow,
  type Sheet,
  type StageMap,
} from '@/lib/migration/migrationRules';

export const MIGRATION_MAX_ROWS = 5000;
export const MIGRATION_LEASE_TTL_MS = 30 * 60 * 1000;

export class MigrationError extends Error {
  constructor(
    public code: 'invalid_stage_target' | 'too_many_rows' | 'migration_running',
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export interface MigrationInput {
  sheets: Partial<Record<Sheet, string>>;
  mapping?: Partial<Record<Sheet, ColumnMapping>>;
  stageMap?: StageMap;
}

export interface MigrationOptions {
  orgId: string;
  dryRun: boolean;
  locale?: Locale;
  now?: Date;
}

export interface SheetReport {
  counts: ImportReport['counts'];
  total: number;
  /** Required fields neither mapped nor named in the header. */
  missing: string[];
  rows: { row: number; key: string; status: RowResult['status']; reason?: string; changed?: string[] }[];
}

export interface MigrationResult {
  dryRun: boolean;
  sheets: Partial<Record<Sheet, SheetReport>>;
  stages: { key: string; label: string }[];
}

interface KnownPerson {
  id: string | null;
  role: string;
  sameOrg: boolean;
}

interface KnownPair {
  relationId: string | null;
  status: 'ACTIVE' | 'COMPLETED';
  /** The stage history starts from (before this run's moves). */
  startingStage: string;
  existed: boolean;
}

function toSheetReport(report: ImportReport<unknown>, missing: string[]): SheetReport {
  return {
    counts: report.counts,
    total: report.total,
    missing,
    rows: report.rows.map((r) => ({ row: r.row, key: r.key, status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.changed?.length ? { changed: r.changed } : {}) })),
  };
}

const echo = <T>(chunk: PlannedRow<T>[]): RowResult<T>[] =>
  chunk.map((p) => ({ row: p.row, key: p.key, status: p.status, ...(p.reason ? { reason: p.reason } : {}), ...(p.changed ? { changed: p.changed } : {}), value: p.value }));

const failed = <T>(p: PlannedRow<T>, error: unknown, tag: string): RowResult<T> => {
  const raced = (error as { code?: string }).code === 'P2002';
  if (!raced && !(error instanceof AlreadyActive)) console.error(`[migrate] ${tag} row`, p.row, error);
  return {
    row: p.row,
    key: p.key,
    status: raced ? 'SKIP' : 'ERROR',
    reason: error instanceof AlreadyActive ? 'mentee already has an active mentorship' : raced ? 'already exists' : 'could not be saved',
    value: p.value,
  };
};

class AlreadyActive extends Error {}

/** A migration run. Dry run unless `dryRun: false`; the real run holds the org's migration lease. */
export async function runMigration(input: MigrationInput, opts: MigrationOptions): Promise<MigrationResult> {
  if (opts.dryRun) return runLocked(input, opts);
  const lease = `migration:${opts.orgId}`;
  const holder = `${replicaId().slice(0, 150)}:${randomUUID()}`;
  if (!(await acquireLease(lease, holder, MIGRATION_LEASE_TTL_MS, { store: prismaLeaseStore() }))) {
    throw new MigrationError('migration_running', 'Another migration is being applied in this organization; wait for it to finish');
  }
  try {
    return await runLocked(input, opts);
  } finally {
    // An optimisation only: expiry is what frees a lease a crashed run held.
    await releaseLease(lease, holder, { store: prismaLeaseStore() });
  }
}

async function runLocked(input: MigrationInput, opts: MigrationOptions): Promise<MigrationResult> {
  const now = opts.now ?? new Date();
  const { orgId, dryRun } = opts;
  const stages = await resolvePipelineStages(orgId, opts.locale ?? 'en');
  const stageKeys = new Set(stages.map((s) => s.key));
  const startStage = startStageKey(stages);
  const stageMap = input.stageMap ?? {};
  const bad = invalidStageTargets(stageMap, stageKeys);
  if (bad.length) throw new MigrationError('invalid_stage_target', `Not a stage of this organization: ${bad.join(', ')}`, bad);

  const world = await worldOfOrg(orgId);
  const defaultOrg = await defaultOrgId();
  const people = new Map<string, KnownPerson>();
  const pairs = new Map<string, KnownPair>();
  let password: Promise<string> | null = null;
  const result: MigrationResult = { dryRun, sheets: {}, stages: stages.map((s) => ({ key: s.key, label: s.label })) };

  const tableFor = (sheet: Sheet) => {
    const text = input.sheets[sheet];
    if (!text?.trim()) return null;
    const table = mappedTable(sheet, text, input.mapping?.[sheet]);
    if (table.rows.length > MIGRATION_MAX_ROWS) throw new MigrationError('too_many_rows', `${sheet} has ${table.rows.length} rows; at most ${MIGRATION_MAX_ROWS} per run`);
    return table;
  };

  /** Load every address not yet known into `people`, in one query. */
  const learnPeople = async (emails: string[]) => {
    const unknown = [...new Set(emails)].filter((e) => !people.has(e));
    for (let i = 0; i < unknown.length; i += 1000) {
      const found = await prisma.user.findMany({
        where: { email: { in: unknown.slice(i, i + 1000) }, ...worldUserWhere(world) },
        select: { id: true, email: true, role: true, orgId: true },
      });
      for (const u of found) people.set(u.email.toLowerCase(), { id: u.id, role: u.role, sameOrg: sameTenant(u.orgId, orgId, defaultOrg) });
    }
  };

  // ── people ────────────────────────────────────────────────────────────────
  const peopleTable = tableFor('people');
  if (peopleTable) {
    const report = await runImport<PersonRow, PersonRow & { personId?: string; fill?: Partial<PersonRow> }>({
      dryRun,
      parse: () => peopleTable,
      validate: (row) => validatePerson(row),
      resolve: async (rows) => {
        const existing = await prisma.user.findMany({
          where: { email: { in: [...new Set(rows.map((r) => r.value.email))] }, ...worldUserWhere(world) },
          select: { id: true, email: true, role: true, orgId: true, fullName: true, phone: true, university: true, department: true },
        });
        const byEmail = new Map(existing.map((u) => [u.email.toLowerCase(), u]));
        const seen = new Set<string>();
        const plan = rows.map(({ row, key, value }): PlannedRow<PersonRow & { personId?: string; fill?: Partial<PersonRow> }> => {
          if (seen.has(value.email)) return { row, key, status: 'SKIP', reason: 'duplicate in file', value };
          seen.add(value.email);
          const u = byEmail.get(value.email);
          if (!u) {
            people.set(value.email, { id: null, role: value.role, sameOrg: true });
            return { row, key, status: 'CREATE', value };
          }
          const sameOrg = sameTenant(u.orgId, orgId, defaultOrg);
          people.set(value.email, { id: u.id, role: u.role, sameOrg });
          if (!sameOrg) return { row, key, status: 'SKIP', reason: 'belongs to another organization', value };
          if (u.role !== value.role) return { row, key, status: 'SKIP', reason: `exists as ${u.role}`, value };
          // A migration fills gaps; it never overwrites what a person typed.
          const fill: Partial<PersonRow> = {};
          for (const f of ['phone', 'university', 'department'] as const) if (!u[f] && value[f]) fill[f] = value[f];
          const changed = Object.keys(fill);
          return changed.length
            ? { row, key, status: 'UPDATE', changed, value: { ...value, personId: u.id, fill } }
            : { row, key, status: 'UNCHANGED', value: { ...value, personId: u.id } };
        });
        return { plan, absent: [] };
      },
      apply: async (chunk, ctx) => {
        if (ctx.dryRun) return echo(chunk);
        const out: RowResult<PersonRow & { personId?: string; fill?: Partial<PersonRow> }>[] = [];
        for (const p of chunk) {
          try {
            if (p.status === 'CREATE') {
              password ??= bcrypt.hash(randomBytes(18).toString('hex'), 10);
              const v = p.value;
              const created = await prisma.user.create({
                data: { email: v.email, fullName: v.fullName, role: v.role, phone: v.phone, university: v.university, department: v.department, password: await password, orgId },
                select: { id: true },
              });
              people.set(v.email, { id: created.id, role: v.role, sameOrg: true });
            } else if (p.status === 'UPDATE' && p.value.personId && p.value.fill) {
              await prisma.user.update({ where: { id: p.value.personId }, data: p.value.fill });
            }
            out.push(...echo([p]));
          } catch (error) {
            out.push(failed(p, error, 'person'));
          }
        }
        return out;
      },
    });
    result.sheets.people = toSheetReport(report, peopleTable.missing);
  }

  // ── pairs ─────────────────────────────────────────────────────────────────
  const pairsTable = tableFor('pairs');
  const historyTable = tableFor('stageHistory');
  const interactionsTable = tableFor('interactions');
  if (pairsTable) {
    const report = await runImport<PairRow, PairRow & { mentorId?: string | null; menteeId?: string | null; relationId?: string }>({
      dryRun,
      parse: () => pairsTable,
      validate: (row) => validatePair(row, now),
      resolve: async (rows) => {
        await learnPeople(rows.flatMap((r) => [r.value.mentorEmail, r.value.menteeEmail]));
        const known = rows
          .map((r) => [people.get(r.value.mentorEmail)?.id, people.get(r.value.menteeEmail)?.id] as const)
          .filter((ids): ids is readonly [string, string] => !!ids[0] && !!ids[1]);
        const existing = known.length
          ? await prisma.mentorshipRelation.findMany({
              where: { OR: known.map(([mentorId, menteeId]) => ({ mentorId, menteeId })) },
              select: { id: true, mentorId: true, menteeId: true, status: true, pipelineStatus: true, startDate: true },
              orderBy: { startDate: 'asc' },
            })
          : [];
        const relationOf = new Map(existing.map((r) => [`${r.mentorId}|${r.menteeId}`, r]));
        const menteeIds = [...new Set(known.map(([, m]) => m))];
        const activeElsewhere = new Map(
          (menteeIds.length
            ? await prisma.mentorshipRelation.findMany({ where: { menteeId: { in: menteeIds }, status: 'ACTIVE' }, select: { id: true, menteeId: true, mentorId: true } })
            : []
          ).map((r) => [r.menteeId, r]),
        );
        const activeInFile = new Set<string>();
        const seen = new Set<string>();
        const plan = rows.map(({ row, key, value }): PlannedRow<PairRow & { mentorId?: string | null; menteeId?: string | null; relationId?: string }> => {
          const fail = (reason: string) => ({ row, key, status: 'SKIP' as const, reason, value });
          if (seen.has(key)) return fail('duplicate in file');
          seen.add(key);
          const mentor = people.get(value.mentorEmail);
          const mentee = people.get(value.menteeEmail);
          if (!mentor) return fail('unknown mentor');
          if (!mentee) return fail('unknown mentee');
          if (!mentor.sameOrg || !mentee.sameOrg) return fail('belongs to another organization');
          if (mentor.role !== 'MENTOR' && mentor.role !== 'ADMIN') return fail(`mentor exists as ${mentor.role}`);
          if (mentee.role !== 'MENTEE') return fail(`mentee exists as ${mentee.role}`);
          const rel = mentor.id && mentee.id ? relationOf.get(`${mentor.id}|${mentee.id}`) : undefined;
          const wantsActive = value.status === 'ACTIVE';
          const blockedBy = mentee.id ? activeElsewhere.get(mentee.id) : undefined;
          const clash = wantsActive && ((blockedBy && blockedBy.id !== rel?.id) || activeInFile.has(value.menteeEmail));
          if (rel) {
            pairs.set(key, { relationId: rel.id, status: rel.status, startingStage: rel.pipelineStatus, existed: true });
            if (rel.status === value.status) return { row, key, status: 'UNCHANGED', value: { ...value, relationId: rel.id } };
            if (clash) return { row, key, status: 'SKIP', reason: 'mentee already has an active mentorship', value };
            if (wantsActive) activeInFile.add(value.menteeEmail);
            return { row, key, status: 'UPDATE', changed: ['status'], value: { ...value, relationId: rel.id } };
          }
          if (clash) return { row, key, status: 'SKIP', reason: 'mentee already has an active mentorship', value };
          if (wantsActive) activeInFile.add(value.menteeEmail);
          pairs.set(key, { relationId: null, status: value.status, startingStage: startStage, existed: false });
          return { row, key, status: 'CREATE', value };
        });
        return { plan, absent: [] };
      },
      apply: async (chunk, ctx) => {
        if (ctx.dryRun) return echo(chunk);
        const out: RowResult<PairRow & { relationId?: string }>[] = [];
        for (const p of chunk) {
          try {
            const v = p.value;
            if (p.status === 'CREATE') {
              const mentorId = people.get(v.mentorEmail)?.id;
              const menteeId = people.get(v.menteeEmail)?.id;
              if (!mentorId || !menteeId) throw new Error('person not created');
              const created = await prisma.$transaction(async (tx) => {
                if (v.status === 'ACTIVE' && (await findActiveMentorship(tx, menteeId))) throw new AlreadyActive();
                return tx.mentorshipRelation.create({
                  data: {
                    mentorId,
                    menteeId,
                    orgId,
                    status: v.status,
                    pipelineStatus: startStage,
                    startDate: v.startDate ?? now,
                    ...(v.status === 'COMPLETED' ? { completedAt: now } : {}),
                    // ACTIVE and COMPLETED are lifecycle states too (#1768) — keep the two columns agreeing.
                    lifecycleState: v.status,
                    // A start stage that is a trial (the MARKETING funnel) opens its window.
                    ...(await stageTrialWindow({ orgId, toStage: startStage, enteredAt: v.startDate ?? now })),
                  },
                  select: { id: true },
                });
              });
              pairs.set(p.key, { relationId: created.id, status: v.status, startingStage: startStage, existed: false });
            } else if (p.status === 'UPDATE' && v.relationId) {
              await prisma.$transaction(async (tx) => {
                if (v.status === 'ACTIVE') {
                  const rel = await tx.mentorshipRelation.findUnique({ where: { id: v.relationId }, select: { menteeId: true } });
                  if (rel && (await findActiveMentorship(tx, rel.menteeId, { exceptRelationId: v.relationId }))) throw new AlreadyActive();
                }
                await tx.mentorshipRelation.update({ where: { id: v.relationId }, data: { status: v.status, lifecycleState: v.status, pausedAt: null, completedAt: v.status === 'COMPLETED' ? now : null } });
              });
              const known = pairs.get(p.key);
              if (known) known.status = v.status;
            }
            out.push(...echo([p]));
          } catch (error) {
            out.push(failed(p, error, 'pair'));
          }
        }
        return out;
      },
    });
    result.sheets.pairs = toSheetReport(report, pairsTable.missing);
  }

  /** Pairs a later sheet names but no pairs sheet listed: existing relations only. */
  const learnPairs = async (keys: { key: string; mentorEmail: string; menteeEmail: string }[]) => {
    const unknown = keys.filter((k) => !pairs.has(k.key));
    if (!unknown.length) return;
    await learnPeople(unknown.flatMap((k) => [k.mentorEmail, k.menteeEmail]));
    const ids = unknown
      .map((k) => ({ k, mentor: people.get(k.mentorEmail), mentee: people.get(k.menteeEmail) }))
      .filter((x) => x.mentor?.id && x.mentee?.id && x.mentor.sameOrg && x.mentee.sameOrg);
    if (!ids.length) return;
    const rels = await prisma.mentorshipRelation.findMany({
      where: { OR: ids.map((x) => ({ mentorId: x.mentor!.id!, menteeId: x.mentee!.id! })) },
      select: { id: true, mentorId: true, menteeId: true, status: true, pipelineStatus: true },
      orderBy: { startDate: 'asc' },
    });
    for (const x of ids) {
      const rel = rels.find((r) => r.mentorId === x.mentor!.id && r.menteeId === x.mentee!.id);
      if (rel && !pairs.has(x.k.key)) pairs.set(x.k.key, { relationId: rel.id, status: rel.status, startingStage: rel.pipelineStatus, existed: true });
    }
  };

  // ── stage history ─────────────────────────────────────────────────────────
  if (historyTable) {
    const touched = new Set<string>();
    type Move = HistoryRow & { fromResolved: string };
    const report = await runImport<HistoryRow, Move>({
      dryRun,
      parse: () => historyTable,
      validate: (row) => validateHistory(row, stageMap, stageKeys, now),
      resolve: async (rows) => {
        await learnPairs(rows.map((r) => ({ key: r.value.pair, mentorEmail: r.value.mentorEmail, menteeEmail: r.value.menteeEmail })));
        const relIds = [...new Set(rows.map((r) => pairs.get(r.value.pair)?.relationId).filter((id): id is string => !!id))];
        const existing = relIds.length
          ? await prisma.statusChange.findMany({ where: { relationId: { in: relIds } }, select: { relationId: true, fromStatus: true, toStatus: true, createdAt: true }, orderBy: { createdAt: 'asc' } })
          : [];
        const already = new Set(existing.map((s) => `${s.relationId}|${s.toStatus}|${s.createdAt.toISOString()}`));
        // A pair that already has history starts from where that history started.
        const firstFrom = new Map<string, string>();
        for (const s of existing) if (!firstFrom.has(s.relationId)) firstFrom.set(s.relationId, s.fromStatus);

        const byPair = new Map<string, { row: number; key: string; value: HistoryRow }[]>();
        for (const r of rows) byPair.set(r.value.pair, [...(byPair.get(r.value.pair) ?? []), r]);
        const plan: PlannedRow<Move>[] = [];
        for (const [pair, list] of byPair) {
          const known = pairs.get(pair);
          if (!known) {
            for (const r of list) plan.push({ row: r.row, key: r.key, status: 'SKIP', reason: 'unknown pair', value: { ...r.value, fromResolved: '' } });
            continue;
          }
          const start = known.relationId && firstFrom.has(known.relationId) ? firstFrom.get(known.relationId)! : known.startingStage;
          const { moves, rejected } = orderHistory(list.map((r) => ({ row: r.row, value: r.value })), start);
          for (const rej of rejected) {
            const r = list.find((x) => x.row === rej.row)!;
            // A row the chain makes X → X is never written (#934).
            plan.push({ row: r.row, key: r.key, status: 'SKIP', reason: rej.reason, value: { ...r.value, fromResolved: '' } });
          }
          for (const m of moves) {
            const r = list.find((x) => x.row === m.row)!;
            const dup = known.relationId && already.has(`${known.relationId}|${m.toStage}|${m.at.toISOString()}`);
            plan.push({ row: r.row, key: r.key, status: dup ? 'UNCHANGED' : 'CREATE', value: { ...r.value, fromResolved: m.fromStage } });
          }
        }
        return { plan: plan.sort((a, b) => a.row - b.row), absent: [] };
      },
      apply: async (chunk, ctx) => {
        if (ctx.dryRun) return echo(chunk);
        const out: RowResult<Move>[] = [];
        for (const p of chunk) {
          try {
            if (p.status === 'CREATE') {
              const relationId = pairs.get(p.value.pair)?.relationId;
              if (!relationId) throw new Error('pair not created');
              // changedById NULL: the move happened in the old system; naming
              // the importing admin would claim a decision they did not make.
              await prisma.statusChange.create({ data: { relationId, fromStatus: p.value.fromResolved, toStatus: p.value.toStage, createdAt: p.value.at, changedById: null } });
              touched.add(relationId);
            }
            out.push(...echo([p]));
          } catch (error) {
            out.push(failed(p, error, 'history'));
          }
        }
        return out;
      },
    });
    // One source of truth: every touched pair stands where its LAST move took it.
    if (!dryRun) {
      for (const relationId of touched) {
        const last = await prisma.statusChange.findFirst({ where: { relationId }, orderBy: { createdAt: 'desc' }, select: { toStatus: true, createdAt: true } });
        if (!last) continue;
        const rel = await prisma.mentorshipRelation.findUnique({ where: { id: relationId }, select: { trialStartedAt: true, trialEndsAt: true } });
        await prisma.mentorshipRelation.update({
          where: { id: relationId },
          data: {
            pipelineStatus: last.toStatus,
            // Entering a trial stage opens its window from the moment of the move, as every stage writer does.
            ...(await stageTrialWindow({ orgId, toStage: last.toStatus, enteredAt: last.createdAt, existing: rel })),
          },
        });
      }
    }
    result.sheets.stageHistory = toSheetReport(report, historyTable.missing);
  }

  // ── interactions ──────────────────────────────────────────────────────────
  if (interactionsTable) {
    const report = await runImport<InteractionRow, InteractionRow>({
      dryRun,
      parse: () => interactionsTable,
      validate: (row) => validateInteraction(row, now),
      resolve: async (rows) => {
        await learnPairs(rows.map((r) => ({ key: r.value.pair, mentorEmail: r.value.mentorEmail, menteeEmail: r.value.menteeEmail })));
        const relIds = [...new Set(rows.map((r) => pairs.get(r.value.pair)?.relationId).filter((id): id is string => !!id))];
        const existing = relIds.length
          ? await prisma.interactionLog.findMany({ where: { relationId: { in: relIds } }, select: { relationId: true, date: true, type: true, notes: true } })
          : [];
        const already = new Set(existing.map((l) => interactionKey(l.relationId, l.date, l.type, l.notes)));
        const seen = new Set<string>();
        const plan = rows.map(({ row, key, value }): PlannedRow<InteractionRow> => {
          const known = pairs.get(value.pair);
          if (!known) return { row, key, status: 'SKIP', reason: 'unknown pair', value };
          const id = interactionKey(known.relationId ?? value.pair, value.at, value.type, value.notes);
          if (seen.has(id)) return { row, key, status: 'SKIP', reason: 'duplicate in file', value };
          seen.add(id);
          return already.has(id) ? { row, key, status: 'UNCHANGED', value } : { row, key, status: 'CREATE', value };
        });
        return { plan, absent: [] };
      },
      apply: async (chunk, ctx) => {
        if (ctx.dryRun) return echo(chunk);
        const out: RowResult<InteractionRow>[] = [];
        for (const p of chunk) {
          try {
            if (p.status === 'CREATE') {
              const relationId = pairs.get(p.value.pair)?.relationId;
              if (!relationId) throw new Error('pair not created');
              await prisma.interactionLog.create({ data: { relationId, date: p.value.at, type: p.value.type, subject: p.value.subject, notes: p.value.notes } });
            }
            out.push(...echo([p]));
          } catch (error) {
            out.push(failed(p, error, 'interaction'));
          }
        }
        return out;
      },
    });
    result.sheets.interactions = toSheetReport(report, interactionsTable.missing);
  }

  return result;
}
