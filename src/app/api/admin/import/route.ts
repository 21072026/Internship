import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createUser } from '@/lib/userCreate';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { logActivity } from '@/lib/activity';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';
import { loadDuplicatePool, rankDuplicates } from '@/lib/duplicateDetection';
import { normalizeEmail, worldOfOrg, worldUserWhere } from '@/lib/userWorld';
import { candidateTable, planCandidates, validateCandidate, type CandidatePlan, type ImportRow } from '@/lib/csvImport';
import { runImport, type RowResult, type RowStatus } from '@/lib/importPreview';
import { requirePermission } from '@/lib/authz';

const schema = z.object({ csv: z.string().min(1).max(200_000), dryRun: z.boolean().optional() });

// POST — bulk-create MENTEE accounts from CSV text.
// Columns: fullName,email[,phone,university,department]. A header row with
// "email" is detected and skipped. Existing emails are skipped.
//
// It runs on the shared import engine (src/lib/importPreview.ts, #2072): the
// row rules in src/lib/csvImport.ts (#1432) are its parse / validate / plan,
// so the preview and the run are ONE program and "will create N" is a promise.
// Every field is checked against its column before anything is written, a bad
// row is reported rather than thrown, and a write that still fails (a race on
// the address, the database going away) marks that row and the import carries
// on. The answer is always a full per-row report — never an empty 500 with
// half the file written.
//
// The response keeps the fields the settings screen has always read
// (`willCreate`/`created`, `skipped`, `errors`, `rows[].email|status|reason|
// possibleDuplicates`) and adds `report`, the engine's shared shape that
// <ImportPreview> draws.
const legacyStatus = (s: RowStatus) => (s === 'CREATE' ? 'create' : s === 'ERROR' ? 'error' : 'skip');

export async function POST(request: Request) {
  const gate = await requirePermission('user.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const dryRun = parsed.data.dryRun === true;
  const orgId = resolveOrgId(session);
  // The importing admin's world, resolved once: the organization's product
  // does not change mid-import.
  const world = await worldOfOrg(orgId);
  // Nobody knows this password — the account is claimed through a reset. ONE
  // hash per import, not per row, and only when something is written: bcrypt
  // at cost 10 is ~90 ms, which made a 500-row file a 45-second request for a
  // secret that is thrown away.
  let password: Promise<string> | null = null;

  const report = await runImport<ImportRow, CandidatePlan>({
    dryRun,
    parse: () => candidateTable(parsed.data.csv),
    validate: (row) => validateCandidate(row),
    resolve: async (rows) => {
      // "Already exists" is decided IN THE IMPORTING ADMIN'S WORLD (#2590): a
      // row whose address only holds an account in the other product is a new
      // person here and is created, not skipped. One query per chunk of
      // addresses, not one per row.
      const candidates = [...new Set(rows.map((r) => normalizeEmail(r.value.email)))];
      const taken = new Set<string>();
      for (let i = 0; i < candidates.length; i += 1000) {
        const found = await prisma.user.findMany({
          where: { email: { in: candidates.slice(i, i + 1000) }, ...worldUserWhere(world) },
          select: { email: true },
        });
        for (const u of found) taken.add(normalizeEmail(u.email));
      }
      const plan = planCandidates(rows, taken);
      // Duplicate pre-flight (#841): report-only — the import proceeds either
      // way, the row just carries the matches. The org's candidates are read
      // once for the whole file.
      const pool = await loadDuplicatePool(orgId);
      for (const p of plan) {
        if (p.status !== 'CREATE') continue;
        const matches = rankDuplicates({ fullName: p.value.data.fullName, phone: p.value.data.phone, university: p.value.data.university }, pool);
        if (matches.length > 0) p.value.possibleDuplicates = matches.map((m) => ({ id: m.id, fullName: m.fullName, matchedOn: m.signals }));
      }
      return { plan, absent: [] };
    },
    apply: async (chunk, ctx) => {
      const out: RowResult<CandidatePlan>[] = [];
      for (const p of chunk) {
        const result: RowResult<CandidatePlan> = { row: p.row, key: p.key, status: p.status, ...(p.reason ? { reason: p.reason } : {}), value: p.value };
        if (ctx.dryRun || p.status !== 'CREATE') {
          out.push(result);
          continue;
        }
        // Row by row, each caught: one row that cannot be written is that
        // row's report line, never the chunk's or the file's.
        try {
          password ??= bcrypt.hash(randomBytes(18).toString('hex'), 10);
          await createUser(prisma, {
            data: {
              ...p.value.data,
              password: await password,
              role: 'MENTEE',
              // Inherit the importing admin's org so CSV-imported users stay inside
              // the tenant's counts/isolation, like every other create path (#678).
              orgId,
            },
          }, { source: 'import', actorId: session.user.id });
          out.push(result);
        } catch (error) {
          // Another request took the address between the check and the write.
          const raced = (error as { code?: string }).code === 'P2002';
          if (!raced) console.error('[admin/import] row', p.row, error);
          out.push({ ...result, status: raced ? 'SKIP' : 'ERROR', reason: raced ? 'already exists' : 'could not be saved' });
        }
      }
      return out;
    },
  });

  const rows = report.rows.map((r) => ({
    row: r.row,
    email: r.key,
    status: legacyStatus(r.status),
    ...(r.reason ? { reason: r.reason } : {}),
    // Look-alike existing candidates (#841) — warn-only, the row is still
    // created/creatable; the admin reviews and merges from /admin/duplicates.
    ...(r.status === 'CREATE' && r.value?.possibleDuplicates?.length ? { possibleDuplicates: r.value.possibleDuplicates } : {}),
  }));
  const shared = {
    dryRun: report.dryRun,
    total: report.total,
    counts: report.counts,
    rows: report.rows.map((r, i) => ({
      row: r.row,
      key: r.key,
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(rows[i].possibleDuplicates ? { possibleDuplicates: rows[i].possibleDuplicates } : {}),
    })),
  };
  const { CREATE: create, SKIP: skipped, ERROR: errors } = report.counts;
  if (dryRun) return NextResponse.json({ dryRun: true, willCreate: create, skipped, errors, rows, report: shared });

  await logActivity({ action: 'users.bulk_import', actorId: session.user.id, actorEmail: session.user.email ?? null, detail: `created ${create}` });
  return NextResponse.json({ created: create, skipped, errors, rows, report: shared });
  });
}
