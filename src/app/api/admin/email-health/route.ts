import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getEmailHealth } from '@/lib/emailHealth';

// Admin view of the e-mail delivery health (#1190) — the settings page shows
// "last successful e-mail" from this. Same derived, PII-scrubbed shape as the
// /api/health detail block, but reachable with a normal admin session instead
// of the health token.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ email: await getEmailHealth() });
}
