import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { logActivity } from '@/lib/activity';
import { listTrustedDevices, readRememberToken, revokeTrustedDevice } from '@/lib/trustedDevice';
import { clearRememberCookies } from '@/lib/rememberCookie';

/**
 * DELETE — forget one remembered device.
 *
 * Scoped to the caller's own account inside revokeTrustedDevice(), so an id
 * belonging to somebody else is simply not found. Revoking the device you are
 * sitting at also drops its cookie — the current session survives, it just
 * stops renewing itself silently.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const token = await readRememberToken();
  const isCurrent = token
    ? (await listTrustedDevices(session.user.id, token)).some((d) => d.id === id && d.current)
    : false;

  const revoked = await revokeTrustedDevice(id, session.user.id);
  if (!revoked) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await logActivity({
    action: 'auth.device_forgotten',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'TrustedDevice',
    targetId: id,
    request,
  });

  const res = NextResponse.json({ ok: true });
  if (isCurrent) clearRememberCookies(res);
  return res;
}
