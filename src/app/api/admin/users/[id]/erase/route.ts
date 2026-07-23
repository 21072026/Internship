import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { anonymizeUser, hardDeleteUser } from '@/lib/accountErasure';
import { withTenantScope } from '@/lib/orgContext';

const bodySchema = z.object({
  mode: z.enum(['anonymize', 'delete']),
  // Extra confirmation gate: the admin must type the candidate's current
  // full name exactly (mirrors requiring a password on self-service delete —
  // an admin has no password to re-check for someone else's account).
  confirmName: z.string().min(1),
});

// POST — admin-initiated right-to-erasure on a candidate (EPIC: GDPR data
// retention). Scoped to role MENTEE only — an admin cannot erase another
// admin or mentor through this endpoint, by design.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { mode, confirmName } = parsed.data;

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true, fullName: true } });
  if (!target || target.role !== 'MENTEE') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (confirmName.trim() !== target.fullName) {
    return NextResponse.json({ error: 'Name does not match — erasure cancelled' }, { status: 400 });
  }

  if (mode === 'delete') {
    await hardDeleteUser(id);
  } else {
    await anonymizeUser(id);
  }

  await logActivity({
    action: mode === 'delete' ? 'candidate.erase.delete' : 'candidate.erase.anonymize',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: id,
  });

  return NextResponse.json({ ok: true });
  });
}
