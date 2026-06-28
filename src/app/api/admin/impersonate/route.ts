import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createImpersonationGrant } from '@/lib/impersonation';

const schema = z.object({ targetUserId: z.string().min(1) });

// POST — admin starts impersonating a user. Verifies the caller is a real
// (non-impersonating) admin, audits it, and returns a single-use grant the
// client hands to signIn('impersonate').
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN' || session.user.impersonatorId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'targetUserId is required' }, { status: 400 });
  }
  if (parsed.data.targetUserId === session.user.id) {
    return NextResponse.json({ error: 'You cannot impersonate yourself' }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id: parsed.data.targetUserId } });
  if (!target) {
    return NextResponse.json({ error: 'Target user not found' }, { status: 404 });
  }

  const grant = await createImpersonationGrant(session.user.id, target.id, 'START');
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: 'IMPERSONATE_START', targetId: target.id },
  });

  return NextResponse.json({ grant });
}
