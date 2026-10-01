import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { createInvitation, invitationOrgWhere } from '@/lib/inviteCreate';
import { logCrossTenantDenial, superAdminWorld } from '@/lib/superAdmin';
import { superAdminReaches } from '@/lib/superAdminWorld';
import { emailTakenInOrgWorld } from '@/lib/userWorld';
import { withRequestScope } from '@/lib/requestContext';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { locales } from '@/i18n/config';

// Invite a person as ADMIN into ANY organization (docs/worlds.md § İkinci
// dünyaya davet). Closes the gap that left a brand-new MARKETING org with no way
// to get its first administrator: POST /api/invite always writes into the
// caller's OWN org (`resolveOrgId(session)`), so an operator signed in on the
// internship side could not reach a tenant that has nobody in it yet.
//
// Super-admin only — minting an ADMIN login for another tenant is deciding who
// runs it, the same power as writing its SSO entry point (#1535). A plain
// tenant ADMIN is refused even for their own org: that case already has its
// door (/admin/invite), and one door per power keeps the audit trail readable.
//
// Everything below the gate mirrors POST /api/invite on purpose, with the
// TARGET org in place of the caller's: the same "already registered in this
// world" 409 (asked in the target org's world, so an address that only exists
// in the other product reads like an unknown one), the same (address, org)
// pending-invitation 409, and the ONE creation path, `createInvitation`, whose
// register URL is already on the target org's own product host (#2495).
//
// DELIBERATELY NOT WRAPPED IN withTenantScope — same reason as the sibling
// pipeline-stages route: the org is an explicit path parameter, not the
// caller's own, and binding the super admin's tenant would write the invitation
// into the wrong org. Every query here names the target org itself.

const bodySchema = z.object({
  // '' is the untouched form field: an email-less shareable link (#670).
  email: z.union([z.string().email('Invalid email'), z.literal('')]).optional().nullable(),
  label: z.string().trim().max(TEXT_LIMITS.invitationLabel).optional().nullable(),
  locale: z.enum(locales).optional().nullable(),
});

const ROUTE = 'POST /api/admin/organizations/[id]/invite-admin';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, () => handlePost(request, params));
}

async function handlePost(request: Request, params: Promise<{ id: string }>) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // The refusal comes before the lookup, so it cannot confirm whether a
    // foreign org id exists. The role test is implied by isSuperAdmin() (which
    // already requires ADMIN) but spelled out so the guard reads as ADMIN-only
    // to scripts/openapi-generate.cjs, like the sibling routes.
    //
    // Per world (docs/worlds.md § Super admin): a super admin reaches only the
    // organizations of its own world. For one of the OTHER world the answer is
    // the same 404 a missing id gets, so it cannot probe which ids exist there.
    const world = await superAdminWorld(session);
    if (!world) await logCrossTenantDenial(session, ROUTE, id);
    if (session.user.role !== 'ADMIN' || !world) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const org = await prisma.organization.findUnique({ where: { id }, select: { id: true, vertical: true } });
    if (!org || !superAdminReaches(world, org.vertical)) {
      if (org) await logCrossTenantDenial(session, ROUTE, id);
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }


    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const email = parsed.data.email?.trim() ? parsed.data.email.trim() : null;
    const label = parsed.data.label?.trim() || null;

    if (email) {
      // Asked in the TARGET org's world (#2590) — see POST /api/invite.
      if (await emailTakenInOrgWorld(email, org.id)) {
        return NextResponse.json(
          { error: 'A user with this email already exists', code: 'email_taken_in_world' },
          { status: 409 }
        );
      }
      const existingToken = await prisma.invitationToken.findFirst({
        where: { email, ...(await invitationOrgWhere(org.id)), used: false, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (existingToken) {
        return NextResponse.json(
          { error: 'An active invitation has already been sent to this email', code: 'invitation_pending' },
          { status: 409 }
        );
      }
    }

    // Same language rule as POST /api/invite (#1720): the form's choice, else
    // the inviter's own UI language, else the deployment default.
    const inviter = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { preferredLanguage: true },
    });
    const locale = parsed.data.locale ?? inviter?.preferredLanguage ?? null;

    const { invitationId, registerUrl, emailSent, mailError } = await createInvitation({
      actor: { id: session.user.id, email: session.user.email },
      orgId: org.id,
      email,
      label,
      role: 'ADMIN',
      locale,
      request,
    });

    // `invite.created` (written by createInvitation) already records the
    // invitation itself; this row records the cross-tenant act against the org.
    // No address in the detail — the invitation row it names carries it.
    await logActivity({
      action: 'organization.admin_invited',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'organization',
      targetId: org.id,
      detail: `ADMIN · ${email ? 'email' : 'link'} · invitation ${invitationId}`,
      request,
    });

    return NextResponse.json(
      { invitationId, registerUrl, emailSent, mailError: !!mailError },
      { status: 201 }
    );
  } catch (error) {
    console.error('Invite org admin error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
