import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { resolvePasswordPolicy } from '@/lib/password';

// GET /api/auth/password-policy — the rules a new password will be judged by
// (#1544), so the sign-up, reset and account forms validate exactly what the
// server enforces (#1215). Public on purpose: a visitor on /auth/register has
// no session yet, and the rules are not a secret — they are printed under the
// field. Which org's policy: the signed-in caller's; otherwise the org of the
// invitation token the visitor arrived with (`?token=`), the way /api/register
// resolves the account's org; otherwise the default org.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  let orgId: string | null = null;
  if (session) {
    orgId = await settingsOrgOf(session);
  } else {
    const token = new URL(request.url).searchParams.get('token');
    if (token) {
      const invitation = await prisma.invitationToken.findUnique({ where: { token }, select: { orgId: true } });
      orgId = invitation?.orgId ?? null;
    }
  }
  const { policy, rules, breachCheck } = await resolvePasswordPolicy(orgId);
  return NextResponse.json({ policy, rules, breachCheck }, { headers: { 'Cache-Control': 'no-store' } });
}
