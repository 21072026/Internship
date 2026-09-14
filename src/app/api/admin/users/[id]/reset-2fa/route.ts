import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { clientIp } from '@/lib/clientIp';
import { logger } from '@/lib/logger';
import { notify } from '@/lib/notify';
import { revokeAllTrustedDevices } from '@/lib/trustedDevice';
import { sendTwoFactorResetEmail } from '@/services/emailService';
import { evaluateTwoFactorReset } from '@/lib/twoFactorResetRule';

// POST — an admin clears a locked-out user's second factor (#1543).
//
// The support ticket that actually arrives is "I lost my phone and I never
// saved the recovery codes". Until this existed the only answer was an UPDATE
// statement typed into the production database by hand, because the only writer
// of `twoFactorEnabled`/`twoFactorSecret` was the account holder's own endpoint
// (/api/account/2fa) — which, correctly, refuses to run inside an impersonation
// session (#1039): enrolling there would plant an authenticator the owner does
// not possess, and disabling there would strip their protection under their own
// name in the audit log. So this is its own route, under the admin's own
// identity, and every line below exists to keep it from becoming a quiet way to
// take an account over:
//
//   * the decision is a unit-tested pure rule (src/lib/twoFactorResetRule.ts),
//     fed by a LIVE read of the caller's role and isActive rather than the JWT;
//   * the factor and its recovery codes go in the same write — leaving stale
//     codes behind would re-open the door this just closed;
//   * every session and remembered device is revoked, because a factor removed
//     from a live session is a factor removed from an attacker's live session;
//   * the account owner is told, in-app and by e-mail, WHO did it. A reset the
//     owner never hears about is exactly how an insider attack stays invisible,
//     which is why the mail is sent from here and not left to a preference.
//
// A user inside the tenant's `require2fa` scope is then held at /security-setup
// until they re-enrol (src/lib/twoFactorPolicy.ts). That is the point, not a
// side effect.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const { id } = await params;
    // The caller's capability, read from the database on this request. Scoped
    // to the same tenant as everything else in this block, so a super-admin
    // impersonating a tenant is not a special case here either.
    const actor = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, role: true, isActive: true },
    });
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        orgId: true,
        preferredLanguage: true,
        twoFactorEnabled: true,
      },
    });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const decision = evaluateTwoFactorReset(
      actor
        ? { ...actor, isImpersonating: !!session.user.impersonatorId }
        : null,
      { id: user.id, role: user.role },
    );
    if (!decision.ok) {
      // A refusal is exactly the row an auditor asks for, so it is recorded
      // rather than only returned — an attempt to reset a peer admin's factor
      // is a fact about the actor, not a validation error.
      await logActivity({
        action: 'admin.reset_2fa_denied',
        level: 'warning',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'user',
        targetId: user.id,
        detail: decision.code,
        request,
      });
      return NextResponse.json(
        { error: decision.error, code: decision.code },
        { status: decision.status },
      );
    }

    const actorName = session.user.name || session.user.email || 'an administrator';

    // One transaction for the parts that must not half-apply: a cleared secret
    // with surviving recovery codes, a cleared factor with live sessions, or a
    // reset with no audit trail is worse than no reset at all.
    //
    // The audit rows are written INSIDE it, with `tx`, which is where this route
    // deliberately differs from its neighbours (they call `logActivity()` after
    // the fact, and that helper swallows its own failures so that logging can
    // never break the request it describes). For an account-takeover primitive
    // the trade runs the other way round: if the row naming who did this to whom
    // cannot be written, the reset does not happen either.
    const deletedCodes = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          twoFactorEnabled: false,
          twoFactorSecret: null,
          // The replay guard (#865) is meaningless without a secret, and a
          // stale high-water mark would reject the first codes of the NEXT
          // enrolment until the clock caught up.
          lastTotpStep: null,
          sessionsValidFrom: new Date(),
        },
        select: { id: true },
      });

      // Recovery codes (#1542) ship in a sibling PR, so the model may or may
      // not exist in the client this build was generated from. Resolved at
      // runtime rather than skipped, because the merge order of the two PRs
      // must not decide whether stale codes survive a reset — a surviving code
      // is a second key to the door we just re-locked. Once #1542 has landed
      // this collapses to a plain `tx.twoFactorRecoveryCode.deleteMany(...)`.
      const codes = (tx as unknown as {
        twoFactorRecoveryCode?: {
          deleteMany: (args: { where: { userId: string } }) => Promise<{ count: number }>;
        };
      }).twoFactorRecoveryCode;
      let deleted = 0;
      if (codes) {
        deleted = (await codes.deleteMany({ where: { userId: user.id } })).count;
      }

      const detail = `was ${user.twoFactorEnabled ? 'enabled' : 'not enabled'}; ${deleted} recovery code(s) deleted`;
      await tx.auditLog.create({
        data: {
          actorId: session.user.id,
          action: 'ADMIN_RESET_2FA',
          targetId: user.id,
          detail,
        },
      });
      await tx.activityLog.create({
        data: {
          action: 'admin.reset_2fa',
          level: 'WARNING',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'user',
          targetId: user.id,
          detail,
          // Same origin columns `logActivity()` records (#881): actor + action
          // alone cannot answer "was this really that admin?".
          ip: clientIp(request),
          userAgent: (request.headers.get('user-agent') || '').slice(0, 512) || null,
        },
      });
      return deleted;
    });

    // HARD RULE (docs/remember-me.md): anything that stamps `sessionsValidFrom`
    // must also revoke the trusted devices, or the remembered browser signs
    // itself straight back in — with the factor now gone.
    await revokeAllTrustedDevices(user.id);

    // The structured-log mirror the helper would have produced; the row itself
    // is already committed above.
    logger.warning('admin.reset_2fa', {
      actorId: session.user.id,
      targetType: 'user',
      targetId: user.id,
      detail: `${deletedCodes} recovery code(s) deleted`,
    });

    // Transparency, mirroring impersonation and admin password reset — with the
    // actor named, because "who did this" is the whole question the owner has.
    await notify(user.id, 'security.twoFactorReset', { admin: actorName });
    try {
      // #1720: the mail is written in the language the ACCOUNT chose, not the
      // admin's. Best effort — a dead SMTP queue must not leave the person
      // locked out because the notice could not go out.
      await sendTwoFactorResetEmail({
        to: user.email,
        fullName: user.fullName,
        adminName: actorName,
        locale: user.preferredLanguage,
        orgId: user.orgId,
      });
    } catch (e) {
      console.error('2FA reset notice email failed:', e);
    }

    return NextResponse.json({ ok: true, deletedRecoveryCodes: deletedCodes });
  });
}
