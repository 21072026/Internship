import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { logActivity } from '@/lib/activity';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';
import { loadDuplicatePool, rankDuplicates, type DuplicateSignal } from '@/lib/duplicateDetection';
import { normalizeEmail, worldOfOrg, worldUserWhere } from '@/lib/userWorld';
import { parseImportCsv, planImport, rowProblem } from '@/lib/csvImport';

const schema = z.object({ csv: z.string().min(1).max(200_000), dryRun: z.boolean().optional() });

// POST — bulk-create MENTEE accounts from CSV text.
// Columns: fullName,email[,phone,university,department]. A header row with
// "email" is detected and skipped. Existing emails are skipped.
//
// The row rules live in src/lib/csvImport.ts (#1432) and are the SAME for the
// dry run and the real run, so "will create N" is a promise: every field is
// checked against its column before anything is written, a bad row is reported
// rather than thrown, and a write that still fails (a race on the address, the
// database going away) marks that row and the import carries on. The answer is
// always a full per-row report — never an empty 500 with half the file written.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const dryRun = parsed.data.dryRun === true;
  const orgId = resolveOrgId(session);
  // The importing admin's world, resolved once: the organization's product
  // does not change mid-import.
  const world = await worldOfOrg(orgId);
  const input = parseImportCsv(parsed.data.csv);

  // "Already exists" is decided IN THE IMPORTING ADMIN'S WORLD (#2590): a row
  // whose address only holds an account in the other product is a new person
  // here and is created, not skipped. One query per chunk of addresses, not
  // one per row.
  const candidates = [...new Set(input.filter((r) => !rowProblem(r)).map((r) => normalizeEmail(r.email)))];
  const taken = new Set<string>();
  for (let i = 0; i < candidates.length; i += 1000) {
    const found = await prisma.user.findMany({
      where: { email: { in: candidates.slice(i, i + 1000) }, ...worldUserWhere(world) },
      select: { email: true },
    });
    for (const u of found) taken.add(normalizeEmail(u.email));
  }
  const plan = planImport(input, taken);

  // Duplicate pre-flight (#841): report-only — the import proceeds either way,
  // the row just carries the matches. The org's candidates are read once for
  // the whole file.
  const pool = await loadDuplicatePool(orgId);
  const rows: {
    row: number;
    email: string;
    status: 'create' | 'skip' | 'error';
    reason?: string;
    // Look-alike existing candidates (#841) — warn-only, the row is still
    // created/creatable; the admin reviews and merges from /admin/duplicates.
    possibleDuplicates?: { id: string; fullName: string; matchedOn: DuplicateSignal[] }[];
  }[] = plan.map((p) => {
    if (p.status !== 'create' || !p.data) return { row: p.row, email: p.email, status: p.status, reason: p.reason };
    const matches = rankDuplicates({ fullName: p.data.fullName, phone: p.data.phone, university: p.data.university }, pool);
    return {
      row: p.row,
      email: p.email,
      status: 'create',
      ...(matches.length > 0
        ? { possibleDuplicates: matches.map((m) => ({ id: m.id, fullName: m.fullName, matchedOn: m.signals })) }
        : {}),
    };
  });

  const count = (status: string) => rows.filter((r) => r.status === status).length;
  if (dryRun) {
    return NextResponse.json({ dryRun: true, willCreate: count('create'), skipped: count('skip'), errors: count('error'), rows });
  }

  // Nobody knows this password — the account is claimed through a reset. ONE
  // hash per import, not per row: bcrypt at cost 10 is ~90 ms, which made a
  // 500-row file a 45-second request for a secret that is thrown away.
  const password = await bcrypt.hash(randomBytes(18).toString('hex'), 10);
  let created = 0;
  for (const [i, p] of plan.entries()) {
    if (p.status !== 'create' || !p.data) continue;
    try {
      await prisma.user.create({
        data: {
          ...p.data,
          password,
          role: 'MENTEE',
          // Inherit the importing admin's org so CSV-imported users stay inside
          // the tenant's counts/isolation, like every other create path (#678).
          orgId,
        },
      });
      created++;
    } catch (error) {
      // Another request took the address between the check and the write.
      const raced = (error as { code?: string }).code === 'P2002';
      if (!raced) console.error('[admin/import] row', p.row, error);
      const { row, email } = rows[i];
      rows[i] = raced ? { row, email, status: 'skip', reason: 'already exists' } : { row, email, status: 'error', reason: 'could not be saved' };
    }
  }

  await logActivity({ action: 'users.bulk_import', actorId: session.user.id, actorEmail: session.user.email ?? null, detail: `created ${created}` });
  return NextResponse.json({ created, skipped: count('skip'), errors: count('error'), rows });
  });
}
