// Creating a tenant (#2065): ONE function, so the super admin's wizard
// (POST /api/admin/organizations) and the public self-serve signup (#1749)
// provision an organization with exactly the same code instead of two copies
// that drift.
//
// WHAT IT DOES, IN ONE TRANSACTION
//   the Organization row (name, slug, plan, product, branding) → the product's
//   starting stage preset (#2353) → the starter pack (#2066) and, if asked, its
//   sample programme → the first administrator's ADMIN invitation. Any failure
//   rolls ALL of it back: a half-provisioned organization — a row with no
//   stages, or stages with no organization anyone can sign in to — is worse
//   than none. The mail and the audit lines come after the commit (an
//   `org.created` line for a rolled-back org would be a lie in the one record
//   that must be trustworthy; an SMTP round trip has no business holding a
//   transaction open — inviteCreate.ts makes the same split).
//
// WHAT IT DOES NOT DO
//   Authorization. The caller decides who may provision, and in which product
//   (`vertical` arrives already checked against the caller's world); this
//   module only enforces what is true for ANY caller: a valid unique slug, the
//   white-label entitlement (#1742 — branding and the support address are a
//   plan feature on create exactly as on edit), safe branding values, and an
//   address that is not already an account in this product.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { Locale } from '@/i18n/config';
import { logActivity } from '@/lib/activity';
import { isHexColor, isSafeBrandLogoUrl } from '@/lib/branding';
import { orgPlanHasFeature, planIncludingFeature, type OrgPlan } from '@/lib/orgPlans';
import { slugifyOrg } from '@/lib/orgSlug';
import { provisionStagePreset } from '@/lib/pipelineStages';
import { applyOrgStarterPack, type StarterSummary } from '@/lib/orgStarterPack';
import { deliverInvitation, invitationRegisterUrl, logInvitationCreated, persistInvitation, type CreateInvitationInput } from '@/lib/inviteCreate';
import { emailTakenInWorld } from '@/lib/userWorld';
import type { VerticalKey } from '@/lib/verticals';

export interface ProvisionInput {
  actor: { id: string; email?: string | null };
  name: string;
  slug?: string | null;
  /** Already checked against the caller's world. */
  vertical: VerticalKey;
  plan?: OrgPlan | null;
  branding?: { brandName?: string | null; brandLogoUrl?: string | null; brandColor?: string | null; supportEmail?: string | null };
  starterPack?: boolean;
  sampleProgram?: boolean;
  firstAdmin?: { email: string; locale?: string | null } | null;
  /** The language the stage labels and the starter pack are written in. */
  locale: Locale;
  request?: Request;
}

export type ProvisionRefusal =
  | { code: 'slug_invalid'; status: 400 }
  | { code: 'slug_taken'; status: 409 }
  | { code: 'invalid_brand_color' | 'invalid_brand_logo'; status: 400 }
  | { code: 'feature_locked'; status: 403; feature: 'WHITE_LABEL'; requiredPlan: OrgPlan | null }
  | { code: 'email_taken_in_world'; status: 409 };

export interface Provisioned {
  organization: { id: string; name: string; slug: string; plan: string; vertical: string };
  starterPack: StarterSummary | null;
  invitation: { invitationId: string; registerUrl: string; emailSent: boolean } | null;
}

const blankToNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** Is this slug free? (The wizard asks as you type; create re-checks inside the transaction.) */
export async function orgSlugAvailable(slug: string): Promise<boolean> {
  return !(await prisma.organization.findUnique({ where: { slug }, select: { id: true } }));
}

export async function provisionOrganization(input: ProvisionInput): Promise<{ ok: true; value: Provisioned } | { ok: false; refusal: ProvisionRefusal }> {
  const name = input.name.trim();
  const slug = slugifyOrg(input.slug?.trim() || name);
  if (!slug) return { ok: false, refusal: { code: 'slug_invalid', status: 400 } };
  const plan: OrgPlan = input.plan ?? 'FREE';

  const brandName = blankToNull(input.branding?.brandName);
  const brandLogoUrl = blankToNull(input.branding?.brandLogoUrl);
  const brandColor = blankToNull(input.branding?.brandColor);
  const supportEmail = blankToNull(input.branding?.supportEmail);
  if ((brandName || brandLogoUrl || brandColor || supportEmail) && !orgPlanHasFeature(plan, 'WHITE_LABEL')) {
    return { ok: false, refusal: { code: 'feature_locked', status: 403, feature: 'WHITE_LABEL', requiredPlan: planIncludingFeature('WHITE_LABEL') } };
  }
  if (brandColor && !isHexColor(brandColor)) return { ok: false, refusal: { code: 'invalid_brand_color', status: 400 } };
  if (brandLogoUrl && !isSafeBrandLogoUrl(brandLogoUrl)) return { ok: false, refusal: { code: 'invalid_brand_logo', status: 400 } };

  const adminEmail = blankToNull(input.firstAdmin?.email)?.toLowerCase() ?? null;
  // "Already registered" means IN THIS PRODUCT (#2590): the same mailbox may
  // hold an account in the other world and still be invited here.
  if (adminEmail && (await emailTakenInWorld(adminEmail, input.vertical))) {
    return { ok: false, refusal: { code: 'email_taken_in_world', status: 409 } };
  }
  if (!(await orgSlugAvailable(slug))) return { ok: false, refusal: { code: 'slug_taken', status: 409 } };

  const invitationInput = (orgId: string): CreateInvitationInput => ({
    actor: input.actor,
    orgId,
    email: adminEmail,
    label: null,
    role: 'ADMIN',
    locale: input.firstAdmin?.locale ?? null,
    request: input.request,
  });

  let created: { organization: Provisioned['organization']; starterPack: StarterSummary | null; persisted: Awaited<ReturnType<typeof persistInvitation>> | null };
  try {
    created = await prisma.$transaction(
      async (tx) => {
        const organization = await tx.organization.create({
          // The product is explicit — never the column default.
          data: { name, slug, plan, vertical: input.vertical, brandName, brandLogoUrl, brandColor, supportEmail },
          select: { id: true, name: true, slug: true, plan: true, vertical: true },
        });
        // The product's own stage set first (a no-op for the canonical one),
        // so the starter pack — which only seeds stages for an org with none —
        // never lays a second set beside it.
        await provisionStagePreset(organization.id, organization.vertical, input.locale, tx);
        const starterPack = input.starterPack
          ? await applyOrgStarterPack(organization.id, { tx, locale: input.locale, sampleProgram: input.sampleProgram === true })
          : null;
        const persisted = adminEmail ? await persistInvitation(invitationInput(organization.id), tx) : null;
        return { organization, starterPack, persisted };
      },
      { timeout: 30_000 },
    );
  } catch (e) {
    // Two creates racing for one slug: the unique index decides, and the loser
    // rolled back whole.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { ok: false, refusal: { code: 'slug_taken', status: 409 } };
    }
    throw e;
  }

  await logActivity({
    action: 'org.created',
    actorId: input.actor.id,
    actorEmail: input.actor.email ?? null,
    targetType: 'organization',
    targetId: created.organization.id,
    detail: created.organization.name,
    request: input.request,
  });

  let invitation: Provisioned['invitation'] = null;
  if (created.persisted) {
    const inv = invitationInput(created.organization.id);
    await logInvitationCreated(inv, created.persisted.invitationId);
    const { emailSent } = await deliverInvitation(inv, created.persisted);
    await logActivity({
      action: 'organization.admin_invited',
      actorId: input.actor.id,
      actorEmail: input.actor.email ?? null,
      targetType: 'organization',
      targetId: created.organization.id,
      detail: `ADMIN · email · invitation ${created.persisted.invitationId}`,
      request: input.request,
    });
    invitation = {
      invitationId: created.persisted.invitationId,
      registerUrl: await invitationRegisterUrl(created.persisted.token, created.organization.id),
      emailSent,
    };
  }

  return { ok: true, value: { organization: created.organization, starterPack: created.starterPack, invitation } };
}
