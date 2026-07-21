import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { logActivity } from '@/lib/activity';
import { resolveOrgId } from '@/lib/orgScope';

const schema = z.object({ csv: z.string().min(1).max(200_000), dryRun: z.boolean().optional() });

// Split a CSV line honoring simple double-quoted fields.
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// POST — bulk-create MENTEE accounts from CSV text.
// Columns: fullName,email[,phone,university,department]. A header row with
// "email" is detected and skipped. Existing emails are skipped.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const dryRun = parsed.data.dryRun === true;
  const lines = parsed.data.csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && /(^|,)\s*email\s*(,|$)/i.test(lines[0]) && lines[0].toLowerCase().includes('email')) {
    lines.shift(); // drop header
  }

  let created = 0;
  const skipped: string[] = [];
  const errors: string[] = [];
  // Per-row validation report (1-based row numbers, after header).
  const rows: { row: number; email: string; status: 'create' | 'skip' | 'error'; reason?: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const [fullName, email, phone, university, department] = parseLine(line);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.push(line);
      rows.push({ row: i + 1, email: email || '', status: 'error', reason: 'invalid email' });
      continue;
    }
    const exists = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } });
    if (exists) {
      skipped.push(email);
      rows.push({ row: i + 1, email, status: 'skip', reason: 'already exists' });
      continue;
    }
    rows.push({ row: i + 1, email, status: 'create' });
    if (dryRun) continue;
    const password = await bcrypt.hash(randomBytes(18).toString('hex'), 10);
    await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        fullName: fullName || email.split('@')[0],
        password,
        role: 'MENTEE',
        // Inherit the importing admin's org so CSV-imported users stay inside
        // the tenant's counts/isolation, like every other create path (#678).
        orgId: resolveOrgId(session),
        phone: phone || null,
        university: university || null,
        department: department || null,
      },
    });
    created++;
  }

  const willCreate = rows.filter((r) => r.status === 'create').length;
  if (dryRun) {
    return NextResponse.json({ dryRun: true, willCreate, skipped: skipped.length, errors: errors.length, rows });
  }
  await logActivity({ action: 'users.bulk_import', actorId: session.user.id, actorEmail: session.user.email ?? null, detail: `created ${created}` });
  return NextResponse.json({ created, skipped: skipped.length, errors: errors.length, rows });
}
