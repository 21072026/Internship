import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { logActivity } from '@/lib/activity';

const schema = z.object({ csv: z.string().min(1).max(200_000) });

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

  const lines = parsed.data.csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && /(^|,)\s*email\s*(,|$)/i.test(lines[0]) && lines[0].toLowerCase().includes('email')) {
    lines.shift(); // drop header
  }

  let created = 0;
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const line of lines) {
    const [fullName, email, phone, university, department] = parseLine(line);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errors.push(line); continue; }
    const exists = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } });
    if (exists) { skipped.push(email); continue; }
    const password = await bcrypt.hash(randomBytes(18).toString('hex'), 10);
    await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        fullName: fullName || email.split('@')[0],
        password,
        role: 'MENTEE',
        phone: phone || null,
        university: university || null,
        department: department || null,
      },
    });
    created++;
  }

  await logActivity({ action: 'users.bulk_import', actorId: session.user.id, actorEmail: session.user.email ?? null, detail: `created ${created}` });
  return NextResponse.json({ created, skipped: skipped.length, errors: errors.length });
}
