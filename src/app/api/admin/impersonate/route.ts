import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createImpersonationGrant } from '@/lib/impersonation';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';

const schema = z.object({ targetUserId: z.string().min(1), reason: z.string().max(300).optional() });

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
  // Impersonating another admin would grant elevated destructive access while
  // masked as a different session — never allowed, regardless of reason.
  if (target.role === 'ADMIN') {
    return NextResponse.json({ error: 'Cannot impersonate an admin account' }, { status: 400 });
  }

  const reason = parsed.data.reason?.trim() || null;
  const grant = await createImpersonationGrant(session.user.id, target.id, 'START');
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: 'IMPERSONATE_START', targetId: target.id },
  });
  await logActivity({
    action: 'impersonate.start',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: target.id,
    detail: reason ? `Reason: ${reason}` : undefined,
  });
  // The impersonated user is told their account was accessed (transparency).
  await notify(target.id, 'impersonation', `An administrator accessed your account${reason ? ` (${reason})` : ''}.`);

  return NextResponse.json({ grant });
}
