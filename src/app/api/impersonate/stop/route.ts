import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createImpersonationGrant } from '@/lib/impersonation';

// POST — return from an impersonated session to the original admin. Allowed
// only when the current session carries an impersonatorId. Returns a single-use
// STOP grant for signIn('impersonate').
export async function POST() {
  const session = await getServerSession(authOptions);
  const impersonatorId = session?.user?.impersonatorId;
  if (!session || !impersonatorId) {
    return NextResponse.json({ error: 'Not impersonating' }, { status: 400 });
  }

  const grant = await createImpersonationGrant(impersonatorId, impersonatorId, 'STOP');
  await prisma.auditLog.create({
    data: { actorId: impersonatorId, action: 'IMPERSONATE_STOP', targetId: session.user.id },
  });

  return NextResponse.json({ grant });
}
