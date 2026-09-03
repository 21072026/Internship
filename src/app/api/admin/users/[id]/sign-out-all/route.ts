import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { revokeAllTrustedDevices } from '@/lib/trustedDevice';

// POST — an admin forces a user out of the product, everywhere, right now.
//
// Until this existed the only lever an admin had was deactivating the account,
// which is a much bigger hammer (the person cannot come back at all) and the
// wrong one for "their laptop was stolen" or "revoke that contractor's open
// tabs". The code even pointed at admin password reset as the lockout tool
// (`/api/account/sign-out-all`), but that only mails a link — it revokes
// nothing, and the existing sessions keep working until the link is used.
//
// The revocation recipe is exactly the one the account-owned route uses:
// stamp `sessionsValidFrom` so every JWT minted earlier is rejected on its next
// request, and revoke every remembered device — required, not optional: a
// remembered browser would otherwise mint itself a fresh session moments later,
// the exact opposite of what the admin pressed.
//
// Governance is copied verbatim from POST /api/admin/users/[id]/reset-password:
// ADMIN only, scoped to the caller's tenant, never a peer admin, never from an
// impersonation session, and audited under the caller's own id.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Not from an impersonation session (#1039). An admin wearing someone else's
  // identity must not be able to reach a security control that is logged as a
  // deliberate administrative act.
  if (session.user.impersonatorId) {
    return NextResponse.json(
      { error: 'Cannot sign a user out of all devices while impersonating' },
      { status: 400 }
    );
  }

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, fullName: true, role: true },
    });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Same rule as impersonation and admin password reset: one admin must not
    // be able to act on another admin's account. Kicking a peer out of every
    // session is exactly that, one step removed.
    if (user.role === 'ADMIN' && user.id !== session.user.id) {
      return NextResponse.json({ error: 'Cannot sign out another admin' }, { status: 400 });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { sessionsValidFrom: new Date() },
      select: { id: true },
    });
    // HARD RULE (docs/remember-me.md): anything that sets sessionsValidFrom
    // must also revoke the trusted devices.
    await revokeAllTrustedDevices(user.id);

    await prisma.auditLog.create({
      data: { actorId: session.user.id, action: 'ADMIN_SIGN_OUT_ALL', targetId: user.id },
    });
    await logActivity({
      action: 'admin.sign_out_all',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: user.id,
      request,
    });
    // Transparency, mirroring impersonation and admin reset: the account owner
    // hears about it rather than just finding themselves signed out.
    await notify(user.id, 'security.adminSignedOutAll', {});

    return NextResponse.json({ ok: true });
  });
}
