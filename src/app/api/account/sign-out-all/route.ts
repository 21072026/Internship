import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';

// POST — "Sign out of all devices". Stamps sessionsValidFrom = now so every
// existing JWT (including the caller's own) is rejected on its next request.
// The client should call signOut() right after to clear its local cookie.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  await prisma.user.update({
    where: { id: session.user.id },
    data: { sessionsValidFrom: new Date() },
  });
  await logActivity({
    action: 'account.sign_out_all',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
  });
  return NextResponse.json({ ok: true });
  });
}
