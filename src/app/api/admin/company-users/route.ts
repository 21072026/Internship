import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';
import { createPasswordResetToken } from '@/lib/passwordReset';
import { sendPasswordResetEmail } from '@/services/emailService';
import { withTenantScope } from '@/lib/orgContext';

const schema = z.object({
  companyId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
});

// POST — admin provisions a read-only COMPANY login for a company. The user is
// created unverified with a placeholder password and emailed a set-password link.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }
  const { companyId, email, fullName } = parsed.data;

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });

  const user = await prisma.user.create({
    data: { email, fullName, role: 'COMPANY', companyId, password: '!company-no-login', emailVerified: false, skills: [] },
  });

  const token = await createPasswordResetToken(user.id, 'SET_INITIAL');
  // The link is emailed and NOT returned (#987, the decision recorded in
  // docs/pii-access-lifecycle.md). It is a live, single-use credential: putting
  // it in an HTTP response body puts it in reverse-proxy logs, browser
  // devtools and every screen share — the same leak #875 closed for
  // /api/admin/users/[id]/reset-password. Neither admin screen ever read it.
  let emailSent = true;
  try {
    await sendPasswordResetEmail({ to: user.email, token, fullName: user.fullName, purpose: 'SET_INITIAL', orgId: user.orgId });
  } catch (e) {
    console.error('Company-user set-password email failed:', e);
    emailSent = false;
  }

  await logActivity({
    action: 'companyuser.created',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: user.id,
    // Say so in the audit trail when the mail failed: the account exists and
    // cannot be reached, which is exactly the state somebody will be trying to
    // explain later.
    detail: emailSent ? `company ${company.name}` : `company ${company.name} — set-password email failed to send`,
    request,
  });
  // `emailSent: false` means the account exists but nobody can get into it.
  // Before #987 this was swallowed and the admin was told "created", full stop.
  return NextResponse.json({ ok: true, emailSent });
  });
}
