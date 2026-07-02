import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

const bodySchema = z.object({
  candidateIds: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(['activate', 'deactivate']),
});

// POST — bulk activate/deactivate candidates from the admin candidates grid
// (EPIC: HR bulk operations). Scoped to role MENTEE as defense in depth —
// this endpoint can never touch an admin/mentor account even if the caller
// somehow sent the wrong IDs.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { candidateIds, action } = parsed.data;
  const isActive = action === 'activate';

  const result = await prisma.user.updateMany({
    where: { id: { in: candidateIds }, role: 'MENTEE' },
    data: { isActive },
  });

  await logActivity({
    action: `candidates.bulk.${action}`,
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: candidateIds.join(','),
  });

  return NextResponse.json({ ok: true, updated: result.count });
}
