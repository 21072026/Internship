import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { listTrustedDevices, readRememberToken } from '@/lib/trustedDevice';

/**
 * GET — the devices this account has chosen to stay signed in on (#1495).
 *
 * "Remember me" is only defensible if the user can see and undo it, so this
 * feeds the list in the account page's session section. Nothing secret is
 * returned: a label, when it was last used and from which IP.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const devices = await listTrustedDevices(session.user.id, await readRememberToken());
  return NextResponse.json({ devices });
}
