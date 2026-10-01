import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';
import { createPasswordResetToken } from '@/lib/passwordReset';
import { sendPasswordResetEmail } from '@/services/emailService';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { emailTakenInOrgWorld } from '@/lib/userWorld';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';

const schema = z.object({
  sourceId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
});

// POST — admin provisions a SOURCE login for a referral source. Unlike company
// logins, SOURCE users can add mentees (tagged to their source). Created with a
// placeholder password + emailed a set-password link.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { sourceId, email, fullName } = parsed.data;

  // Same tenant only (#2570; #2542 had to leave this open while the source
  // create paths stamped no orgId): a login is never minted for another
  // tenant's source.
  const orgId = resolveOrgId(session);
  const source = await prisma.source.findFirst({ where: withinTenant({ id: sourceId }, await tenantWhere(session)) });
  if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 });

  // "Already exists" means IN THE ADMIN'S WORLD (#2590) — see
  // /api/admin/company-users: an account under the same address in the other
  // product is a different person-record, not a conflict.
  if (await emailTakenInOrgWorld(email, orgId)) {
    return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });
  }

  const user = await prisma.user.create({
    // `orgId` by hand (#2542): see /api/admin/company-users.
    data: { email, fullName, role: 'SOURCE', sourceId, orgId, password: '!source-no-login', emailVerified: false, skills: [] },
  });

  const token = await createPasswordResetToken(user.id, 'SET_INITIAL');
  // #1720: a brand-new account has no language of its own — the creating admin's
  // is the best evidence available. See the same note in company-users.
  const creator = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferredLanguage: true },
  });
  // The link is emailed and NOT returned (#987, the decision recorded in
  // docs/pii-access-lifecycle.md). It is a live, single-use credential: putting
  // it in an HTTP response body puts it in reverse-proxy logs, browser
  // devtools and every screen share — the same leak #875 closed for
  // /api/admin/users/[id]/reset-password. Neither admin screen ever read it.
  // Derived from what the transport actually reported, not from "did not
  // throw" (#1431): sendEmail returns normally on the demo-mode and
  // no-SMTP paths, and reading that silence as success is what told an admin
  // an account was reachable when nobody could sign in to it.
  let emailSent = true;
  try {
    emailSent =
      (await sendPasswordResetEmail({
        to: user.email,
        token,
        fullName: user.fullName,
        purpose: 'SET_INITIAL',
        orgId: user.orgId,
        locale: creator?.preferredLanguage,
      })) === 'SENT';
  } catch (e) {
    console.error('Source-user set-password email failed:', e);
    emailSent = false;
  }

  await logActivity({
    action: 'sourceuser.created',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: user.id,
    // Say so in the audit trail when the mail failed: the account exists and
    // cannot be reached, which is exactly the state somebody will be trying to
    // explain later.
    detail: emailSent ? `source ${source.name}` : `source ${source.name} — set-password email failed to send`,
    request,
  });
  // `emailSent: false` means the account exists but nobody can get into it.
  // Before #987 this was swallowed and the admin was told "created", full stop.
  return NextResponse.json({ ok: true, emailSent });
  });
}
