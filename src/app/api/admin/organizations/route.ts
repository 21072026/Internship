import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';
import { ORG_PLAN_KEYS, planLimits, isOrgPlan, orgPlanHasFeature, planIncludingFeature, type OrgPlan } from '@/lib/orgPlans';
import { isHexColor, isSafeBrandLogoUrl } from '@/lib/branding';
import { validateSsoConfig, isSsoActive } from '@/lib/sso';
import { spEntityId, acsUrl, metadataUrl } from '@/lib/ssoSaml';
import { isSuperAdmin, logCrossTenantDenial } from '@/lib/superAdmin';
import { resolveOrgId } from '@/lib/orgScope';

// Multi-tenancy (#544/#547): super-admin management of Organizations (tenants).
// Phase 1 is additive/foundational — orgId is nullable and not yet enforced in
// queries, so this screen lets an admin create tenants, set their plan, and see
// usage vs. the plan's (advisory) limits. Query isolation lands in a later slice.

// GET — organizations with plan, limits and per-tenant usage.
// A super admin sees every tenant; a plain tenant ADMIN sees exactly their own
// organisation, and nothing at all when they belong to none (#1535).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const superAdmin = await isSuperAdmin(session);
  let where: { id: string } | undefined;
  if (!superAdmin) {
    const ownOrgId = resolveOrgId(session);
    if (!ownOrgId) {
      await logCrossTenantDenial(session, 'GET /api/admin/organizations', null);
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    where = { id: ownOrgId };
  }

  const orgs = await prisma.organization.findMany({
    where,
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: {
          users: true,
          sources: true,
          cohorts: true,
          companies: true,
          projects: true,
          relations: true,
        },
      },
    },
  });

  return NextResponse.json({
    plans: ORG_PLAN_KEYS,
    // Lets the admin screen hide what this account cannot use. Presentation
    // only — the checks above and below are the actual control.
    superAdmin,
    organizations: orgs.map((o) => {
      const plan = o.plan as OrgPlan;
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        plan,
        limits: planLimits(plan),
        branding: {
          brandName: o.brandName,
          brandLogoUrl: o.brandLogoUrl,
          brandColor: o.brandColor,
          supportEmail: o.supportEmail,
        },
        sso: {
          ssoEnabled: o.ssoEnabled,
          ssoProvider: o.ssoProvider,
          ssoIssuer: o.ssoIssuer,
          ssoEntryPoint: o.ssoEntryPoint,
          // Never expose the raw certificate to the list view; just whether one is set.
          ssoCertificateSet: !!o.ssoCertificate,
          active: isSsoActive(o),
          // The three values a customer's IT team registers in their IdP
          // (#1931). Computed here, not in the browser: they hang off
          // NEXTAUTH_URL, which is a server concern — a value derived from
          // window.location would be wrong behind a custom domain.
          spEntityId: spEntityId(o.slug),
          acsUrl: acsUrl(o.slug),
          metadataUrl: metadataUrl(o.slug),
        },
        createdAt: o.createdAt,
        counts: {
          users: o._count.users,
          sources: o._count.sources,
          cohorts: o._count.cohorts,
          companies: o._count.companies,
          projects: o._count.projects,
          relations: o._count.relations,
        },
      };
    }),
  });
}

// URL-safe slug: lowercase, alphanumerics + single hyphens, no leading/trailing.
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  plan: z.enum(['FREE', 'PRO', 'ENTERPRISE']).optional(),
});

// POST — create an organization. Creating tenants is an instance-level act, so
// it is super-admin only (#1535).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(await isSuperAdmin(session))) {
    await logCrossTenantDenial(session, 'POST /api/admin/organizations', null);
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const name = parsed.data.name.trim();
  const slug = slugify(parsed.data.slug || name);
  if (!slug) return NextResponse.json({ error: 'Could not derive a valid slug from the name' }, { status: 400 });

  const existing = await prisma.organization.findUnique({ where: { slug } });
  if (existing) return NextResponse.json({ error: 'An organization with that slug already exists' }, { status: 409 });

  const organization = await prisma.organization.create({
    data: { name, slug, plan: parsed.data.plan ?? 'FREE' },
  });
  await logActivity({
    action: 'org.created',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'organization',
    targetId: organization.id,
    detail: organization.name,
    request,
  });
  return NextResponse.json({ organization }, { status: 201 });
}

// Empty string clears an optional branding field (stored as null).
const optionalText = z.string().max(200).optional();
const patchSchema = z.object({
  id: z.string().min(1),
  plan: z.string().refine(isOrgPlan, 'Invalid plan').optional(),
  brandName: optionalText,
  brandLogoUrl: z.string().max(2000).optional(),
  brandColor: z.string().optional(),
  supportEmail: z.string().max(200).optional(),
  // SSO config (#545).
  ssoEnabled: z.boolean().optional(),
  ssoProvider: z.string().max(20).optional(),
  ssoIssuer: z.string().max(500).optional(),
  ssoEntryPoint: z.string().max(2000).optional(),
  ssoCertificate: z.string().max(20000).optional(),
});

function orNull(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined; // field not provided → leave unchanged
  const t = v.trim();
  return t.length ? t : null; // blank → clear
}

// White-label branding and SAML SSO are premium features, and this handler is
// the ONLY way either is written — so this is where they are gated (#1742). The
// entitlement comes from the tenant's plan (orgPlanHasFeature); an unentitled
// tenant is refused with the shared feature_locked shape below. The locked card
// on the admin screen is cosmetic; this is the gate.
//
// `requiredPlan` is part of the contract (#1736): a refusal that only says "no"
// forces every caller to re-derive the packaging to render an upgrade CTA.
function featureLocked(feature: 'WHITE_LABEL' | 'SSO_SAML') {
  return NextResponse.json(
    {
      code: 'feature_locked',
      feature,
      requiredPlan: planIncludingFeature(feature),
      error: `This feature (${feature}) is not included in the organization's current plan`,
    },
    { status: 403 }
  );
}

// Is every premium field in this payload being CLEARED? A request that can only
// null columns is exempt from the entitlement check (#1742): the gate exists to
// stop an unentitled tenant *acquiring* a paid feature, and refusing the delete
// too would mean branding bought once renders forever — in every branded e-mail
// and on the certificate PDF — with no way for anyone, super admin included, to
// remove it without first re-upgrading the plan. Undoing is always allowed;
// only a non-empty value needs the entitlement.
function isPureClear(values: (string | boolean | undefined)[]): boolean {
  const provided = values.filter((v) => v !== undefined);
  if (!provided.length) return false;
  // `ssoEnabled: false` is a clear (switch off); `true` is not.
  return provided.every((v) => (typeof v === 'boolean' ? v === false : v!.trim() === ''));
}

// PATCH — change an organization's plan, branding and/or SSO config.
// The target org comes from the request body, so this is where a tenant ADMIN
// could otherwise overwrite ANOTHER customer's SAML entry point and signing
// certificate (#1535). A super admin may target any org; a tenant ADMIN only
// their own.
export async function PATCH(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const {
    id, plan, brandName, brandLogoUrl, brandColor, supportEmail,
    ssoEnabled, ssoProvider, ssoIssuer, ssoEntryPoint, ssoCertificate,
  } = parsed.data;

  // Ownership is settled BEFORE the target row is touched: a 404-after-403
  // ordering would let a foreign admin probe which org ids exist.
  const superAdmin = await isSuperAdmin(session);
  if (!superAdmin) {
    const ownOrgId = resolveOrgId(session);
    if (!ownOrgId || ownOrgId !== id) {
      await logCrossTenantDenial(session, 'PATCH /api/admin/organizations', id);
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // Fetched before the field validation below so the entitlement answer never
  // depends on whether the payload happened to be well-formed.
  const existing = await prisma.organization.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });

  // The plan is what the premium gate below reads, so who may WRITE it decides
  // whether that gate means anything (#1742). A tenant ADMIN owns their org and
  // would otherwise self-upgrade — one request carrying `plan: 'ENTERPRISE'`
  // alongside a SAML config would pass every check in this handler. Changing a
  // tenant's tier is a billing act, not a tenant-administration one: super
  // admins only, same as creating the tenant in POST above. A no-op (the plan
  // it is already on) is not a change and stays allowed, so a client that
  // echoes the current plan back is not broken by this.
  if (plan !== undefined && plan !== existing.plan && !superAdmin) {
    await logCrossTenantDenial(session, 'PATCH /api/admin/organizations (plan)', id);
    return NextResponse.json({ error: 'Only a super admin may change an organization\'s plan' }, { status: 403 });
  }

  // Entitlement is read from the plan this request leaves the org on. Now that
  // only a super admin can move that plan, granting the tier and configuring
  // the feature it unlocks in one request is the operator doing two legitimate
  // things at once, not an escalation.
  const effectivePlan = plan ?? existing.plan;

  const touchesBranding = brandName !== undefined || brandLogoUrl !== undefined ||
    brandColor !== undefined || supportEmail !== undefined;
  const clearsBranding = isPureClear([brandName, brandLogoUrl, brandColor, supportEmail]);
  if (touchesBranding && !clearsBranding && !orgPlanHasFeature(effectivePlan, 'WHITE_LABEL')) {
    return featureLocked('WHITE_LABEL');
  }

  const touchesSso = ssoEnabled !== undefined || ssoProvider !== undefined ||
    ssoIssuer !== undefined || ssoEntryPoint !== undefined || ssoCertificate !== undefined;
  const clearsSso = isPureClear([ssoEnabled, ssoProvider, ssoIssuer, ssoEntryPoint, ssoCertificate]);
  if (touchesSso && !clearsSso && !orgPlanHasFeature(effectivePlan, 'SSO_SAML')) {
    return featureLocked('SSO_SAML');
  }

  // Validate an explicitly-set (non-blank) brand color as a hex value.
  if (brandColor && brandColor.trim() && !isHexColor(brandColor)) {
    return NextResponse.json({ error: 'Brand color must be a hex value like #2563eb' }, { status: 400 });
  }

  // The logo URL is fetched by the server when a certificate is rendered and is
  // interpolated into every branded email — a bare `z.string()` let an admin
  // point either at an internal address. See isSafeBrandLogoUrl.
  if (brandLogoUrl !== undefined && !isSafeBrandLogoUrl(brandLogoUrl)) {
    return NextResponse.json(
      { error: 'Logo URL must be an https:// address, a path like /logo.svg, or an inline data:image' },
      { status: 400 }
    );
  }

  const data: Record<string, unknown> = {};
  if (plan !== undefined) data.plan = plan;
  const bn = orNull(brandName); if (bn !== undefined) data.brandName = bn;
  const bl = orNull(brandLogoUrl); if (bl !== undefined) data.brandLogoUrl = bl;
  const bc = orNull(brandColor); if (bc !== undefined) data.brandColor = bc;
  const se = orNull(supportEmail); if (se !== undefined) data.supportEmail = se;

  // SSO fields: only touch what's provided, then validate the effective config
  // (existing merged with the incoming changes) — so enabling requires a
  // complete config even if some fields were set in an earlier request.
  if (touchesSso) {
    if (ssoEnabled !== undefined) data.ssoEnabled = ssoEnabled;
    const sp = orNull(ssoProvider); if (sp !== undefined) data.ssoProvider = sp;
    const si = orNull(ssoIssuer); if (si !== undefined) data.ssoIssuer = si;
    const sep = orNull(ssoEntryPoint); if (sep !== undefined) data.ssoEntryPoint = sep;
    const sc = orNull(ssoCertificate); if (sc !== undefined) data.ssoCertificate = sc;

    const effective = {
      ssoEnabled: (data.ssoEnabled as boolean | undefined) ?? existing.ssoEnabled,
      ssoProvider: (data.ssoProvider as string | null | undefined) ?? existing.ssoProvider,
      ssoIssuer: (data.ssoIssuer as string | null | undefined) ?? existing.ssoIssuer,
      ssoEntryPoint: (data.ssoEntryPoint as string | null | undefined) ?? existing.ssoEntryPoint,
      ssoCertificate: (data.ssoCertificate as string | null | undefined) ?? existing.ssoCertificate,
    };
    const err = validateSsoConfig(effective);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });

  const organization = await prisma.organization.update({ where: { id }, data });
  await logActivity({
    // SSO config lives behind this endpoint, so a change to it can redirect
    // authentication itself — warning rather than info when that is touched.
    action: 'org.updated',
    level: 'ssoEnabled' in data || 'ssoIssuer' in data || 'ssoEntryPoint' in data ? 'warning' : 'info',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'organization',
    targetId: organization.id,
    detail: Object.keys(data).join(', '),
    request,
  });
  return NextResponse.json({ organization });
}
