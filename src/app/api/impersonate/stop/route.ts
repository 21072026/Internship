import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createImpersonationGrant } from '@/lib/impersonation';
import { logActivity } from '@/lib/activity';

// POST — return from an impersonated session to the original admin. Allowed
// only when the current session carries an impersonatorId. Returns a single-use
// STOP grant for signIn('impersonate').
//
// WORLDS (#2590): nothing to add here, on purpose. The grant names the admin's
// OWN account (`createImpersonationGrant(impersonatorId, impersonatorId, …)`),
// and an impersonation can only have started inside the admin's world — the
// start route (api/admin/impersonate) refuses a target of the other product, and
// the `impersonate` provider re-checks the account's world against the host on
// every sign-in, STOP included. So the admin's account and the host this runs on
// are in the same world by construction; there is no second account to pick
// between and no e-mail lookup anywhere on this path.
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
  await logActivity({ action: 'impersonate.stop', level: 'warning', actorId: impersonatorId, targetType: 'user', targetId: session.user.id });

  return NextResponse.json({ grant });
}
