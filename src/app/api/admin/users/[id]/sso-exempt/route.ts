import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { isSuperAdmin, logCrossTenantDenial } from '@/lib/superAdmin';
import { countExemptAdmins } from '@/lib/ssoEnforcement';

// POST — grant or revoke the break-glass exemption from enforced SSO (#1950).
//
// Enforced SSO is the one setting in this product that can lock a customer out
// of their own tenant: switch it on, have the IdP go down or the certificate
// expire, and nobody can sign in to switch it off again. The exemption is the
// way back in, and `PATCH /api/admin/organizations` refuses to enable
// enforcement at all until at least one active ADMIN holds one.
//
// Because it is a way *around* the tenant's own security control, it is
// deliberately narrow:
//
//   * only an ADMIN may grant it, never from an impersonation session;
//   * only an active ADMIN of the caller's own tenant may RECEIVE it — an
//     exemption on a mentee account is a permanent password back door into a
//     tenant that told its auditors it had none;
//   * every grant and revocation is audited (`sso.exempt_granted` /
//     `sso.exempt_revoked`, level warning, plus an AuditLog row), and the
//     holder is notified — a quiet exemption is the dangerous kind;
//   * the last exemption cannot be revoked while the org is enforcing, which is
//     the same anti-lockout rule read from the other end.
//
// It is deliberately NOT time-boxed. An exemption that silently expires
// recreates exactly the lockout it exists to prevent, on a day nobody chose.
// The narrowing is "who holds it", not "for how long" — and the audit trail is
// what makes a stale one findable.
const schema = z.object({ exempt: z.boolean() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.user.impersonatorId) {
    return NextResponse.json(
      { error: 'Cannot change an SSO exemption while impersonating' },
      { status: 400 }
    );
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { exempt } = parsed.data;

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, fullName: true, role: true, isActive: true, orgId: true, ssoExempt: true },
    });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // Checked explicitly rather than left to the tenant middleware: that only
    // engages when MT_ENFORCE_ISOLATION is on, and it is off in production
    // (#1549). A control that hands out a password back door must not depend on
    // a flag that is switched off.
    const callerOrgId = resolveOrgId(session);
    if (!(await isSuperAdmin(session)) && (!callerOrgId || callerOrgId !== user.orgId)) {
      await logCrossTenantDenial(session, 'POST /api/admin/users/[id]/sso-exempt', user.orgId);
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Narrow by construction: only an active admin can be the way back in.
    if (exempt && (user.role !== 'ADMIN' || !user.isActive)) {
      return NextResponse.json(
        { error: 'Only an active administrator can hold an SSO exemption' },
        { status: 400 }
      );
    }

    if (user.ssoExempt === exempt) {
      return NextResponse.json({ ok: true, ssoExempt: exempt, unchanged: true });
    }

    // The anti-lockout rule, read backwards: removing the last exemption while
    // the tenant is enforcing leaves nobody who can sign in with a password if
    // the IdP fails. Switch enforcement off first.
    if (!exempt && user.orgId) {
      const org = await prisma.organization.findUnique({
        where: { id: user.orgId },
        select: { ssoEnforced: true },
      });
      if (org?.ssoEnforced && (await countExemptAdmins(user.orgId)) <= 1) {
        return NextResponse.json(
          {
            error:
              'This is the last SSO exemption in an organization that enforces SSO. Grant another admin an exemption, or switch enforcement off first.',
            code: 'last_sso_exemption',
          },
          { status: 400 }
        );
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { ssoExempt: exempt },
      select: { id: true },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: exempt ? 'SSO_EXEMPT_GRANTED' : 'SSO_EXEMPT_REVOKED',
        targetId: user.id,
      },
    });
    await logActivity({
      action: exempt ? 'sso.exempt_granted' : 'sso.exempt_revoked',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: user.id,
      detail: `${user.email} may ${exempt ? 'now' : 'no longer'} sign in with a password while SSO is enforced`,
      request,
    });
    // Transparency, mirroring impersonation and admin force sign-out: the
    // account holder hears that their account is now the tenant's back door.
    await notify(user.id, exempt ? 'security.ssoExemptGranted' : 'security.ssoExemptRevoked', {});

    return NextResponse.json({ ok: true, ssoExempt: exempt });
  });
}
