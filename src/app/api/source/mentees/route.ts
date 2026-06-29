import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { logActivity } from '@/lib/activity';

// The source a SOURCE user represents (their own sourceId).
async function ownSourceId(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { sourceId: true, role: true } });
  return u?.role === 'SOURCE' ? u.sourceId : null;
}

// GET — mentees this source has submitted, with their current assignment (if any).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'SOURCE') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sourceId = await ownSourceId(session.user.id);
  if (!sourceId) return NextResponse.json({ error: 'No source' }, { status: 403 });

  const mentees = await prisma.user.findMany({
    where: { role: 'MENTEE', sourceId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, fullName: true, email: true, university: true, department: true, skills: true, createdAt: true,
      menteeRelations: {
        where: { status: 'ACTIVE' },
        select: { pipelineStatus: true, mentor: { select: { fullName: true } } },
        take: 1,
      },
    },
  });
  return NextResponse.json({
    mentees: mentees.map((m) => ({
      id: m.id, fullName: m.fullName, email: m.email, university: m.university, department: m.department,
      skills: Array.isArray(m.skills) ? m.skills : [],
      assigned: m.menteeRelations.length > 0,
      mentor: m.menteeRelations[0]?.mentor.fullName ?? null,
      pipelineStatus: m.menteeRelations[0]?.pipelineStatus ?? null,
      createdAt: m.createdAt,
    })),
  });
}

const schema = z.object({
  fullName: z.string().min(1).max(160),
  email: z.string().email(),
  university: z.string().max(160).optional(),
  department: z.string().max(160).optional(),
  skills: z.string().max(500).optional(),
});

// POST — a source submits a new mentee. Created as an unassigned MENTEE tagged
// with this source; a mentor/admin picks them up and assigns project/company.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'SOURCE') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sourceId = await ownSourceId(session.user.id);
  if (!sourceId) return NextResponse.json({ error: 'No source' }, { status: 403 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const { fullName, email, university, department, skills } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } });
  if (existing) return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });

  const password = await bcrypt.hash(randomBytes(18).toString('hex'), 10);
  const mentee = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      fullName,
      role: 'MENTEE',
      sourceId,
      university: university || null,
      department: department || null,
      skills: skills ? skills.split(',').map((s) => s.trim()).filter(Boolean) : [],
      password,
    },
    select: { id: true, fullName: true, email: true },
  });
  await logActivity({ action: 'source.mentee_added', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'user', targetId: mentee.id });
  return NextResponse.json({ mentee }, { status: 201 });
}
