import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';

// Stage key is a free string now (#747) so tenant-defined stages are accepted.
const stage = z.string().min(1).max(60);
const schema = z.object({
  relationId: z.string().min(1),
  fromStatus: stage,
  toStatus: stage,
  createdAt: z.string().datetime().optional(),
});

// POST — admin manually adds a stage-history entry to correct the audit trail.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }

    const { relationId, fromStatus, toStatus, createdAt } = parsed.data;
    const relation = await prisma.mentorshipRelation.findUnique({ where: { id: relationId } });
    if (!relation) {
      return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
    }

    const change = await prisma.statusChange.create({
      data: {
        relationId,
        fromStatus,
        toStatus,
        changedById: session.user.id,
        ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
      },
    });

    return NextResponse.json({ change }, { status: 201 });
  });
}
