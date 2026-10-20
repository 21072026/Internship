import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { recordOrgWrite } from '@/lib/orgAudit';
import { z } from 'zod';
import { ORG_PLAN_KEYS, planLimits, isOrgPlan, orgPlanHasFeature, planIncludingFeature, type OrgPlan } from '@/lib/orgPlans';
import { isHexColor, isSafeBrandLogoUrl } from '@/lib/branding';
import { VERTICAL_KEYS, isVerticalKey, toVerticalKey } from '@/lib/verticals';
import { countVerticalMoveConflicts, VERTICAL_MOVE_EMAIL_CONFLICT } from '@/lib/verticalMove';
import { validateSsoConfig, isSsoActive } from '@/lib/sso';
import { spEntityId, acsUrl, metadataUrl } from '@/lib/ssoSaml';
import { isSuperAdminFor, logCrossTenantDenial, superAdminWorld } from '@/lib/superAdmin';
import { creatableVertical, orgInWorld, orgWorldWhere } from '@/lib/superAdminWorld';
import { resolveOrgId } from '@/lib/orgScope';
import { provisionOrganization, type ProvisionRefusal } from '@/lib/orgProvisioning';
import { locales } from '@/i18n/config';
import { getLocale } from '@/i18n/server';
import { IS_DEMO_MODE } from '@/lib/demoMode';
import {
  applySsoEnforcement,
  countExemptAdmins,
  countSweepableUsers,
  ssoEnforcementBlockers,
} from '@/lib/ssoEnforcement';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { isAccentColor } from '@/lib/accent';
import { BRAND_ACCENT, normalizeHex, paletteIsReadable, parsePalette } from '@/lib/brandRule';
import { invalidateBrandCache } from '@/lib/hostBrand';

// Multi-tenancy (#544/#547): super-admin management of Organizations (tenants).
// Phase 1 is additive/foundational — orgId is nullable and not yet enforced in
// queries, so this screen lets an admin create tenants, set their plan, and see
// usage vs. the plan's (advisory) limits. Query isolation lands in a later slice.

// GET — organizations with plan, limits and per-tenant usage.
// A super admin sees every tenant OF ITS OWN WORLD (docs/worlds.md § Super
// admin) — an INTERNSHIP super admin never lists a MARKETING organization and
// vice versa; a plain tenant ADMIN sees exactly their own organisation, and
// nothing at all when they belong to none (#1535).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const world = await superAdminWorld(session);
  const superAdmin = world !== null;
  let where: ReturnType<typeof orgWorldWhere> | { id: string } = world ? orgWorldWhere(world) : {};
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

  // What the enforcement toggle needs to be honest about before it is pressed
  // (#1950): how many break-glass admins exist (the anti-lockout interlock) and
  // how many sessions the flip would end. Two grouped queries for the whole
  // page rather than two per row.
  const orgIds = orgs.map((o) => o.id);
  const [exemptAdminRows, sweepableRows] = orgIds.length
    ? await Promise.all([
        prisma.user.groupBy({
          by: ['orgId'],
          where: { orgId: { in: orgIds }, role: 'ADMIN', isActive: true, ssoExempt: true },
          _count: { _all: true },
        }),
        prisma.user.groupBy({
          by: ['orgId'],
          where: { orgId: { in: orgIds }, ssoExempt: false },
          _count: { _all: true },
        }),
      ])
    : [[], []];
  const exemptAdmins = new Map(exemptAdminRows.map((r) => [r.orgId, r._count._all]));
  const sweepable = new Map(sweepableRows.map((r) => [r.orgId, r._count._all]));

  return NextResponse.json({
    plans: ORG_PLAN_KEYS,
    // The vertical catalogue (#2350). Sent with the list for the same reason
    // `plans` is: the screen must not hard-code a key set the server owns. For
    // a super admin it is the verticals it may CREATE — its own world's only.
    verticals: world ? VERTICAL_KEYS.filter((k) => orgInWorld(k, world)) : VERTICAL_KEYS,
    // The world this super admin manages (null for a tenant admin).
    world,
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
        // Normalised on the way out: a row holding a key the catalogue no
        // longer knows renders as the default instead of an unknown string
        // the screen has no option for.
        vertical: toVerticalKey(o.vertical),
        limits: planLimits(plan),
        branding: {
          brandName: o.brandName,
          brandLogoUrl: o.brandLogoUrl,
          brandColor: o.brandColor,
          supportEmail: o.supportEmail,
          // The per-organization brand (#2922).
          brandTileColor: o.brandTileColor,
          brandAccent: o.brandAccent,
          brandPalette: o.brandPalette,
          brandMarkVersion: o.brandMarkVersion,
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
          // Enforced SSO (#1950): the flag, plus the two numbers the admin
          // screen needs to name the consequence before anyone presses it.
          ssoEnforced: o.ssoEnforced,
          exemptAdmins: exemptAdmins.get(o.id) ?? 0,
          sessionsToEnd: sweepable.get(o.id) ?? 0,
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

// What a create may carry (#2065). Everything beyond name/slug/plan/vertical
// is optional, so the quick form on the list page and the wizard share one
// door. The server applies it — the client never posts stages or a pre-built
// configuration, only choices.
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().max(60).optional(),
  plan: z.enum(['FREE', 'PRO', 'ENTERPRISE']).optional(),
  brandName: z.string().max(TEXT_LIMITS.orgBrandName).optional(),
  brandLogoUrl: z.string().max(2000).optional(),
  brandColor: z.string().max(TEXT_LIMITS.orgBrandColor).optional(),
  supportEmail: z.union([z.string().email().max(TEXT_LIMITS.orgSupportEmail), z.literal('')]).optional(),
  starterPack: z.boolean().optional(),
  sampleProgram: z.boolean().optional(),
  firstAdminEmail: z.union([z.string().trim().email().max(191), z.literal('')]).optional(),
  firstAdminLocale: z.enum(locales).optional(),
  // Validated against the catalogue rather than a second hand-written list:
  // a z.enum() copy here is exactly the drift that makes a new key type-check
  // everywhere and 400 at the only door that creates tenants.
  // REQUIRED since per-world super admins: a new customer is typed by its
  // product at birth, never by the column default, and only in the caller's
  // own world (checked in the handler, where the world is known).
  vertical: z.string().refine(isVerticalKey, 'Unknown vertical'),
});

// POST — create an organization. Creating tenants is an instance-level act, so
// it is super-admin only (#1535).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Signed in but not an administrator: refused whatever the body carries
  // (#2065) — the wizard's extra fields add no way around this line.
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const world = await superAdminWorld(session);
  if (!world) {
    await logCrossTenantDenial(session, 'POST /api/admin/organizations', null);
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (body && typeof body === 'object' && !('vertical' in body)) {
    return NextResponse.json(
      { error: 'Choose the product (vertical) for the new organization', code: 'vertical_required' },
      { status: 400 }
    );
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  // A super admin creates organizations in its own world only: a MARKETING
  // operator cannot mint an INTERNSHIP tenant, and the other way round.
  const vertical = creatableVertical(world, parsed.data.vertical);
  if (!vertical) {
    await logCrossTenantDenial(session, 'POST /api/admin/organizations (vertical)', null);
    return NextResponse.json(
      { error: 'You can only create organizations of your own product', code: 'vertical_other_world' },
      { status: 403 }
    );
  }

  // The whole creation — row, stage preset, starter pack, first-admin
  // invitation — is one transaction in provisionOrganization() (#2065); this
  // handler only authenticates, validates and maps its refusals.
  const d = parsed.data;
  const result = await provisionOrganization({
    actor: { id: session.user.id, email: session.user.email },
    name: d.name,
    slug: d.slug,
    vertical,
    plan: d.plan,
    branding: { brandName: d.brandName, brandLogoUrl: d.brandLogoUrl, brandColor: d.brandColor, supportEmail: d.supportEmail },
    starterPack: d.starterPack,
    sampleProgram: d.sampleProgram,
    firstAdmin: d.firstAdminEmail ? { email: d.firstAdminEmail, locale: d.firstAdminLocale ?? null } : null,
    locale: await getLocale(),
    request,
  });
  if (!result.ok) {
    const r = result.refusal;
    if (r.code === 'feature_locked') return featureLocked('WHITE_LABEL');
    return NextResponse.json({ error: PROVISION_ERRORS[r.code], code: r.code }, { status: r.status });
  }
  const { organization, starterPack, invitation } = result.value;
  return NextResponse.json({ organization, starterPack, invitation }, { status: 201 });
}

const PROVISION_ERRORS: Record<Exclude<ProvisionRefusal['code'], 'feature_locked'>, string> = {
  slug_invalid: 'Could not derive a valid slug from the name',
  slug_taken: 'An organization with that slug already exists',
  invalid_brand_color: 'Brand color must be a hex value like #2563eb',
  invalid_brand_logo: 'Brand logo must be an https URL, a same-origin path or an image data URI',
  email_taken_in_world: 'A user with this email already exists',
};

// Empty string clears an optional branding field (stored as null).
const optionalText = z.string().max(TEXT_LIMITS.orgBrandName).optional();
const patchSchema = z.object({
  id: z.string().min(1),
  plan: z.string().refine(isOrgPlan, 'Invalid plan').optional(),
  vertical: z.string().refine(isVerticalKey, 'Unknown vertical').optional(),
  brandName: optionalText,
  brandLogoUrl: z.string().max(2000).optional(),
  brandColor: z.string().max(TEXT_LIMITS.orgBrandColor).optional(),
  supportEmail: z.string().max(TEXT_LIMITS.orgSupportEmail).optional(),
  // The per-organization brand (#2922). Empty string clears, like the others.
  brandTileColor: z.string().max(TEXT_LIMITS.orgBrandTileColor).optional(),
  brandAccent: z.string().max(TEXT_LIMITS.orgBrandAccent).optional(),
  brandPalette: z.string().max(TEXT_LIMITS.orgBrandPalette).optional(),
  // SSO config (#545).
  ssoEnabled: z.boolean().optional(),
  ssoProvider: z.string().max(20).optional(),
  ssoIssuer: z.string().max(TEXT_LIMITS.orgSsoIssuer).optional(),
  ssoEntryPoint: z.string().max(2000).optional(),
  ssoCertificate: z.string().max(20000).optional(),
  // Enforced SSO (#1950). Separate from ssoEnabled on purpose: "our IdP works"
  // and "nothing but our IdP may work" are different promises, and only the
  // second one ends live sessions.
  ssoEnforced: z.boolean().optional(),
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
// certificate (#1535). A super admin may target any org OF ITS OWN WORLD; a
// tenant ADMIN only their own. A super admin of the other world is, for this
// org, a tenant admin of somewhere else — refused like one.
export async function PATCH(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const {
    id, plan, vertical, brandName, brandLogoUrl, brandColor, supportEmail,
    brandTileColor, brandAccent, brandPalette,
    ssoEnabled, ssoProvider, ssoIssuer, ssoEntryPoint, ssoCertificate, ssoEnforced,
  } = parsed.data;

  // Ownership is settled BEFORE the target row is touched: a 404-after-403
  // ordering would let a foreign admin probe which org ids exist.
  const superAdmin = await isSuperAdminFor(session, id);
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

  // Which PRODUCT a tenant is, is an instance-level act for the same reason the
  // plan is (#2350): it decides which modules exist for everyone in that org,
  // and later slices read it to gate write paths. A tenant ADMIN owning their
  // own org must not be able to switch their product. Same shape as the plan
  // rule above, including the no-op exemption.
  if (vertical !== undefined && vertical !== existing.vertical && !superAdmin) {
    await logCrossTenantDenial(session, 'PATCH /api/admin/organizations (vertical)', id);
    return NextResponse.json(
      { error: 'Only a super admin may change an organization\'s vertical' },
      { status: 403 }
    );
  }

  // A vertical change is a move into ANOTHER WORLD — out of the reach of the
  // super admin making it, and into the other world's operator's. Per-world
  // super admins make that a two-operator act, so no single session may do it:
  // refused for everyone (docs/worlds.md § Super admin). A no-op, or a row with
  // an unregistered key normalising to the world it already reads as, passes.
  if (vertical !== undefined && toVerticalKey(existing.vertical) !== toVerticalKey(vertical)) {
    await logCrossTenantDenial(session, 'PATCH /api/admin/organizations (cross-world vertical)', id);
    return NextResponse.json(
      {
        code: 'vertical_other_world',
        error: 'An organization cannot be moved to another product from here: each product has its own super admin.',
      },
      { status: 403 }
    );
  }

  // (Unreachable from a session since the cross-world refusal above; kept as
  // the second lock should that refusal ever be relaxed for an operator path.)
  // A vertical change MOVES every person of the organization into the other
  // world in one UPDATE (worlds, #2590 — src/lib/userWorld.ts: a world is
  // derived from the org, never stored on the user). One person may hold one
  // account per world with the same e-mail, but never two in the SAME world, and
  // the database cannot say so (its unique is per organization). If the
  // destination world already has an account for any address this organization
  // holds, the move would silently create exactly that pair — refused, before
  // anything else in this request is written, with the number of clashes and no
  // address (the addresses belong to other tenants' people; see
  // src/lib/verticalMove.ts). The check is skipped for a no-op or a change that
  // keeps the org in the world it is already in.
  if (vertical !== undefined && toVerticalKey(existing.vertical) !== toVerticalKey(vertical)) {
    const conflicts = await countVerticalMoveConflicts(id, existing.vertical, toVerticalKey(vertical));
    if (conflicts > 0) {
      await logActivity({
        action: 'org.vertical_move_refused',
        level: 'warning',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'organization',
        targetId: id,
        detail: `to ${toVerticalKey(vertical)}: ${conflicts} e-mail address(es) already have an account in that product`,
        request,
        orgId: id,
      });
      return NextResponse.json(
        {
          code: VERTICAL_MOVE_EMAIL_CONFLICT,
          conflicts,
          error:
            'This organization cannot move to the other product yet: some of its people already have an account there under the same e-mail address, and one e-mail may hold only one account per product.',
        },
        { status: 409 }
      );
    }
  }

  // Entitlement is read from the plan this request leaves the org on. Now that
  // only a super admin can move that plan, granting the tier and configuring
  // the feature it unlocks in one request is the operator doing two legitimate
  // things at once, not an escalation.
  const effectivePlan = plan ?? existing.plan;

  const touchesBranding = brandName !== undefined || brandLogoUrl !== undefined ||
    brandColor !== undefined || supportEmail !== undefined ||
    brandTileColor !== undefined || brandAccent !== undefined || brandPalette !== undefined;
  const clearsBranding = isPureClear([brandName, brandLogoUrl, brandColor, supportEmail, brandTileColor, brandAccent, brandPalette]);
  if (touchesBranding && !clearsBranding && !orgPlanHasFeature(effectivePlan, 'WHITE_LABEL')) {
    return featureLocked('WHITE_LABEL');
  }

  const touchesSso = ssoEnabled !== undefined || ssoProvider !== undefined ||
    ssoIssuer !== undefined || ssoEntryPoint !== undefined || ssoCertificate !== undefined ||
    ssoEnforced !== undefined;
  const clearsSso = isPureClear([ssoEnabled, ssoProvider, ssoIssuer, ssoEntryPoint, ssoCertificate, ssoEnforced]);
  if (touchesSso && !clearsSso && !orgPlanHasFeature(effectivePlan, 'SSO_SAML')) {
    return featureLocked('SSO_SAML');
  }

  // WHO may write the IdP trust anchor (#1575). The issuer, entry point and
  // certificate decide whom the ACS signs in: ANY account of the org, of any
  // role, from an assertion checked only against the stored certificate, with
  // no password and no second factor. Writing them is therefore writing who an
  // admin of this org is — and the org that holds the seeded super admin is a
  // tenant too, so a tenant ADMIN who could paste their own certificate could
  // sign in AS that super admin and reach every other tenant. Like the plan and
  // the palette, it is the operator's call. Switching SSO on or off and
  // enforcing it stay the tenant's own policy (they only open or close a trust
  // the operator configured), and clearing the config is always allowed. A
  // value echoed back unchanged is not a write (the SSO form always sends the
  // provider, issuer and entry point with the switch).
  const setsIdpTrust = ([
    [ssoProvider, existing.ssoProvider],
    [ssoIssuer, existing.ssoIssuer],
    [ssoEntryPoint, existing.ssoEntryPoint],
    [ssoCertificate, existing.ssoCertificate],
  ] as const).some(([next, current]) => {
    const value = orNull(next);
    return value !== undefined && value !== null && value !== (current ?? null);
  });
  if (setsIdpTrust && !superAdmin) {
    await logCrossTenantDenial(session, 'PATCH /api/admin/organizations (sso trust)', id);
    return NextResponse.json(
      { code: 'sso_super_admin_only', error: 'Only a super admin may set an organization\'s identity provider' },
      { status: 403 },
    );
  }

  // Validate an explicitly-set (non-blank) brand color as a hex value.
  if (brandColor && brandColor.trim() && !isHexColor(brandColor)) {
    return NextResponse.json({ error: 'Brand color must be a hex value like #2563eb' }, { status: 400 });
  }

  // The per-organization brand (#2922, src/lib/brandRule.ts). The palette is
  // the exact ramp every control of the 'brand' accent is painted from, so who
  // sets it is the operator's call, like the plan: a tenant ADMIN may clear it
  // (undoing is always allowed) but not write one. Every value is checked here
  // in the shape it is read in, so the resolver never meets a half-valid row.
  if (brandTileColor && brandTileColor.trim() && !isHexColor(brandTileColor)) {
    return NextResponse.json({ code: 'invalid_tile_color', error: 'Tile color must be a hex value like #1e293b' }, { status: 400 });
  }
  if (brandAccent && brandAccent.trim() && brandAccent.trim() !== BRAND_ACCENT && !isAccentColor(brandAccent.trim())) {
    return NextResponse.json({ code: 'invalid_accent', error: 'Unknown accent' }, { status: 400 });
  }
  if (brandPalette && brandPalette.trim()) {
    if (!superAdmin) {
      await logCrossTenantDenial(session, 'PATCH /api/admin/organizations (brandPalette)', id);
      return NextResponse.json({ code: 'palette_super_admin_only', error: 'Only a super admin may set an organization\'s palette' }, { status: 403 });
    }
    const palette = parsePalette(brandPalette);
    if (!palette) {
      return NextResponse.json({ code: 'invalid_palette', error: 'A palette is ten hex colours, lightest (50) to darkest (900), separated by commas' }, { status: 400 });
    }
    if (!paletteIsReadable(palette)) {
      return NextResponse.json({ code: 'palette_contrast', error: 'White text on the palette\'s 600 shade must reach 4.5:1 (WCAG AA)' }, { status: 400 });
    }
  }
  // 'brand' needs something to be a palette OF: an exact palette, or a brand
  // colour to generate one from — as the row will stand after this request.
  if (brandAccent?.trim() === BRAND_ACCENT) {
    const nextPalette = brandPalette !== undefined ? brandPalette.trim() : existing.brandPalette;
    const nextColor = brandColor !== undefined ? brandColor.trim() : existing.brandColor;
    if (!nextPalette && !nextColor) {
      return NextResponse.json({ code: 'brand_accent_needs_colour', error: 'Set a brand color or a palette before choosing the organization colour as the accent' }, { status: 400 });
    }
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
  if (vertical !== undefined) data.vertical = vertical;
  const bn = orNull(brandName); if (bn !== undefined) data.brandName = bn;
  const bl = orNull(brandLogoUrl); if (bl !== undefined) data.brandLogoUrl = bl;
  const bc = orNull(brandColor); if (bc !== undefined) data.brandColor = bc;
  const se = orNull(supportEmail); if (se !== undefined) data.supportEmail = se;
  const bt = orNull(brandTileColor); if (bt !== undefined) data.brandTileColor = bt === null ? null : normalizeHex(bt);
  const ba = orNull(brandAccent); if (ba !== undefined) data.brandAccent = ba;
  const bp = orNull(brandPalette); if (bp !== undefined) data.brandPalette = bp === null ? null : (parsePalette(bp) ?? []).join(',');

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

    // The public demo shares ONE tenant between every visitor, and enforcing
    // SSO there would sign all of them out and leave the door open only to
    // whoever granted themselves the exemption first. The middleware's demo
    // block list works on pathnames and cannot see this field, so the refusal
    // lives here — the branding and SSO *config* on this endpoint stay
    // demonstrable, which is the point of the demo.
    if (ssoEnforced === true && IS_DEMO_MODE) {
      return NextResponse.json(
        { error: 'Enforcing SSO would sign every demo visitor out', code: 'demo_blocked' },
        { status: 403 }
      );
    }

    // ── Enforced SSO: the anti-lockout interlock (#1950) ────────────────────
    // Not optional and not advisory. A tenant that switches enforcement on with
    // a misconfigured IdP and no exempt admin has no way back into its own
    // account except our database console — so the two conditions are checked
    // against the config this request LEAVES the org on, which is what lets an
    // operator enable SSO and enforce it in a single save.
    if (ssoEnforced === true && !existing.ssoEnforced) {
      const blockers = await ssoEnforcementBlockers(id, { ...effective, plan: effectivePlan });
      if (blockers.length) {
        return NextResponse.json(
          {
            code: 'sso_enforcement_blocked',
            blockers,
            exemptAdmins: await countExemptAdmins(id),
            error:
              blockers.includes('SSO_NOT_ACTIVE')
                ? 'SSO must be active for this organization before it can be enforced'
                : 'At least one active administrator must hold a break-glass SSO exemption before SSO can be enforced',
          },
          { status: 400 }
        );
      }
    }
    if (ssoEnforced !== undefined) data.ssoEnforced = ssoEnforced;
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });

  // Counted before the flip, while the sweep has not yet stamped anyone: this
  // is what the confirmation dialog promised the admin.
  const willSweep = ssoEnforced === true && !existing.ssoEnforced;
  const sweepPreview = willSweep ? await countSweepableUsers(id) : 0;

  const organization = await prisma.organization.update({ where: { id }, data });

  // The brand changed: every cached read of it in this process is stale, and a
  // generated icon set painted on the old tile colour is re-rendered from its
  // stored original on the new one (a no-op when the tile did not move).
  // brandAssets is imported HERE, not at the top: it pulls in the native image
  // library, and SSO, plan and the rest of this route must keep loading on a
  // host where that library cannot.
  if (touchesBranding) {
    invalidateBrandCache();
    const assets = organization.brandMarkVersion ? await import('@/lib/brandAssets').catch(() => null) : null;
    if (assets && assets.tileFor(organization) !== assets.tileFor(existing)) {
      await assets.rerenderBrandMark(id).catch(() => null);
    }
  }

  // The sweep on flip. Turning enforcement on has to END the sessions that were
  // obtained by password — otherwise every one of them keeps working for
  // another 12 hours and the tenant's "we enforce SSO" is false for the rest of
  // the day. `applySsoEnforcement` stamps sessionsValidFrom AND revokes the
  // trusted devices (the hard rule: neither half works alone) in bounded
  // batches, then writes one audited `sso.enforced` row with the count.
  //
  // Runs only on the OFF → ON edge, so re-saving an already-enforcing tenant
  // does not sign its users out again; running it twice would be harmless
  // anyway, but a no-op save should be a no-op.
  let sessionsEnded = 0;
  if (willSweep) {
    sessionsEnded = await applySsoEnforcement(
      id,
      { id: session.user.id, email: session.user.email ?? null },
      request
    );
  }

  // Field NAMES only — never a value: the SSO fields include the IdP
  // certificate, and this row reaches the tenant's audit drain (#1575).
  await recordOrgWrite({
    orgId: organization.id,
    // SSO config lives behind this endpoint, so a change to it can redirect
    // authentication itself — warning rather than info when that is touched.
    action: 'org.updated',
    level:
      'ssoEnabled' in data || 'ssoIssuer' in data || 'ssoEntryPoint' in data || 'ssoEnforced' in data
        ? 'warning'
        : 'info',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    detail: Object.keys(data).join(', '),
    request,
  });
  return NextResponse.json({ organization, sessionsEnded, sweepPreview });
}
