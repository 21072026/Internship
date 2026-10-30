import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { getEmailHealth } from '@/lib/emailHealth';

// Admin view of the e-mail delivery health (#1190) — the settings page shows
// "last successful e-mail" from this. Same derived, PII-scrubbed shape as the
// /api/health detail block, but reachable with a normal admin session instead
// of the health token.
export async function GET(request: Request) {
  const gate = await requirePermission('mail.read', { request });
  if ('error' in gate) return gate.error;
  return NextResponse.json({ email: await getEmailHealth() });
}
