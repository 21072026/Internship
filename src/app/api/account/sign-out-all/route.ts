import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { revokeAllTrustedDevices } from '@/lib/trustedDevice';
import { clearRememberCookies } from '@/lib/rememberCookie';

// POST — "Sign out of all devices". Stamps sessionsValidFrom = now so every
// existing JWT (including the caller's own) is rejected on its next request.
// The client should call signOut() right after to clear its local cookie.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Not from an impersonation session (#1039). Revoking every device of an
  // account is a security decision for its owner: it is logged as the user
  // though an admin pressed it, it locks the owner out of sessions the admin
  // knows nothing about, and it takes the impersonation session down with it —
  // so the admin lands on the sign-in page as if they had been signed out. An
  // admin who genuinely needs to lock someone out uses
  // POST /api/admin/users/[id]/reset-password, which is audited under their own id.
  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Cannot sign out all devices while impersonating' }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
  await prisma.user.update({
    where: { id: session.user.id },
    data: { sessionsValidFrom: new Date() },
  });
  // Every remembered device too (#1495) — otherwise a browser the user just
  // locked out would silently mint itself a fresh session on its next visit,
  // which is precisely the opposite of what they pressed.
  await revokeAllTrustedDevices(session.user.id);
  await logActivity({
    action: 'account.sign_out_all',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
  });
  const res = NextResponse.json({ ok: true });
  clearRememberCookies(res);
  return res;
  });
}
