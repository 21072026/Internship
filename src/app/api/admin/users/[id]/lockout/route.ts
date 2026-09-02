import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { clearLockoutForUser } from '@/lib/accountLockout';

// DELETE — clear a user's brute-force lockout (#1541).
//
// The counter used to live in a Map in one process, so there was nothing to
// clear: an admin could only tell a locked-out colleague to wait fifteen
// minutes, or redeploy. Now the lockout is a row, and this removes it.
//
// Governance is the same as the other admin actions on a user (see
// POST /api/admin/users/[id]/reset-password): ADMIN only, tenant-scoped, never
// a peer admin, never from an impersonation session, audited under the caller.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Cannot unlock an account while impersonating' }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, role: true },
    });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Unlocking a peer admin's account is a way to hand an attacker who owns
    // one admin account unlimited guesses at another. Same refusal as reset.
    if (user.role === 'ADMIN' && user.id !== session.user.id) {
      return NextResponse.json({ error: 'Cannot unlock another admin' }, { status: 400 });
    }

    const cleared = await clearLockoutForUser(user.id, user.email);

    await prisma.auditLog.create({
      data: { actorId: session.user.id, action: 'ADMIN_UNLOCK_ACCOUNT', targetId: user.id },
    });
    await logActivity({
      action: 'admin.unlock_account',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: user.id,
      detail: `${cleared} lockout row(s) cleared`,
      request,
    });
    if (cleared > 0) {
      await notify(user.id, 'security.accountUnlocked', {});
    }

    return NextResponse.json({ ok: true, cleared });
  });
}
