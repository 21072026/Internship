import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { ALL_CRITERIA, EVALUATION_TYPES } from '@/lib/evaluation';

// GET ?relationId= — evaluations for a relation (participants/admin).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const relationId = new URL(request.url).searchParams.get('relationId') || '';

  const rel = await prisma.mentorshipRelation.findUnique({ where: { id: relationId } });
  if (!rel) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const allowed = session.user.role === 'ADMIN' || rel.mentorId === session.user.id || rel.menteeId === session.user.id;
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const evaluations = await prisma.evaluation.findMany({ where: { relationId }, orderBy: { createdAt: 'desc' } });
  // Tag each evaluation with its direction so the UI can pick the right rubric.
  return NextResponse.json({
    evaluations: evaluations.map((e) => ({
      ...e,
      direction: e.authorId === rel.menteeId ? 'MENTEE_ON_MENTOR' : 'MENTOR_ON_MENTEE',
    })),
  });
}

const scoreSchema = z.record(z.enum(ALL_CRITERIA), z.number().int().min(1).max(5));
const schema = z.object({
  relationId: z.string().min(1),
  type: z.enum(EVALUATION_TYPES).optional(),
  scores: scoreSchema,
  comment: z.string().max(2000).optional().nullable(),
});

// POST — record an evaluation. Mentor/admin evaluate the mentee; the mentee can
// evaluate their mentor (two-way). Direction is inferred from the author.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });

  const rel = await prisma.mentorshipRelation.findUnique({ where: { id: parsed.data.relationId } });
  if (!rel) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const isParticipant = rel.mentorId === session.user.id || rel.menteeId === session.user.id;
  if (session.user.role !== 'ADMIN' && !isParticipant) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const evaluation = await prisma.evaluation.create({
    data: {
      relationId: rel.id,
      authorId: session.user.id,
      type: parsed.data.type ?? 'INTERIM',
      scores: parsed.data.scores,
      comment: parsed.data.comment || null,
    },
  });
  return NextResponse.json({ evaluation }, { status: 201 });
}
