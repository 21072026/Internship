// The permission rule (#1569, story #1565): "may this actor do this action to
// this subject?" — pure, dependency-free and unit-tested
// (scripts/test/authz-rule.test.mjs). The server half that reads the session,
// the live user row and the scope grants is src/lib/authz.ts; nothing here
// touches Prisma, so the rule can be read top to bottom.
//
// NOT TO BE CONFUSED WITH `requireCapability()` in src/lib/capabilityGate.ts.
// That one asks whether a module is part of the tenant's PRODUCT (a vertical
// capability: `mentorship`, …). This one asks whether a PERSON may do an
// action. The words differ on purpose — a "permission" is an actor's
// authority, a "capability" is a product's feature set — and so do the names:
// `Permission`, `can()`, `requirePermission()`.
//
// FAIL CLOSED, the same shape as src/lib/authzScope.ts: a permission nobody
// listed, an account without an admin tier, a PROGRAM_ADMIN without a grant
// and an OBSERVER asking for anything but a read are all refused, and the
// refusal names its reason so the denial row says why.
//
// The platform tier is not a column. A `platform.*` permission is held only by
// the per-world super admin (`User.isSuperAdmin`, src/lib/superAdmin.ts) and
// only for organizations of its own world — the caller computes that fact
// with the existing world rule and passes it in as `platformReach`. Nothing
// here can make a tenant admin a platform operator, and no non-platform
// permission crosses a tenant boundary, the super admin's included (#1575).

export const PERMISSIONS = [
  // Platform — the per-world super admin only.
  'platform.org.read',
  'platform.org.write',
  'platform.sso.write',
  'platform.plan.write',
  'platform.apikey.write',
  'platform.openapi.read',
  'platform.benchmark.read',
  // The organization itself.
  'org.settings.read',
  'org.settings.write',
  'org.branding.write',
  'org.invite',
  'org.integrations.read',
  'org.integrations.write',
  // The tenant's own offboarding export (#1584): every row of the org, no
  // credentials. ORG_ADMIN only — it is a write-tier power although it writes
  // nothing, because it hands out the whole tenant at once.
  'org.export',
  // People.
  'user.read',
  'user.write',
  'user.impersonate',
  'user.erase',
  'user.reset_password',
  'user.role_convert',
  'user.merge',
  // Programmes and the pipeline.
  'program.read',
  'program.write',
  'relation.write',
  'pipeline.transition',
  // Reporting: dashboards, analytics, health and SLA read-outs (#1571).
  'analytics.read',
  // Templates and authored content an admin publishes to the programme:
  // forms, surveys, newsletters, announcements, message/goal/agenda templates,
  // skills and attributes (#1571).
  'content.read',
  'content.write',
  // The mail pipeline of the tenant: log, queue, held drafts, suppressions (#1571).
  'mail.read',
  'mail.write',
  // In-app support tickets and bug reports, and safeguarding concerns (#1571).
  // Safeguarding is its own pair: a report about a person's safety is not a
  // support ticket, and a later tier may hold one without the other.
  'support.read',
  'support.write',
  'safeguarding.read',
  'safeguarding.write',
  // Trails.
  'audit.read',
  'audit.export',
  'activity.read',
  // Companies.
  'company.read',
  'company.write',
  'company.entitlements.write',
  // The affiliate programme (docs/affiliate-module.md): settings, partners,
  // payments, commissions, payouts. Writes move money, so ORG_ADMIN only.
  'affiliate.read',
  'affiliate.write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** The column values of `User.adminLevel` (prisma/schema.prisma, enum AdminLevel). */
export const ADMIN_TIERS = ['ORG_ADMIN', 'PROGRAM_ADMIN', 'OBSERVER'] as const;
export type AdminTier = (typeof ADMIN_TIERS)[number];

const KNOWN: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && KNOWN.has(value);
}

export function isPlatformPermission(p: Permission): boolean {
  return p.startsWith('platform.');
}

/** A read: the only kind an OBSERVER may hold, and the only kind an impersonated session keeps. */
export function isReadPermission(p: Permission): boolean {
  return p.endsWith('.read');
}

const TENANT_PERMISSIONS = PERMISSIONS.filter((p) => !isPlatformPermission(p));
const TENANT_READS = TENANT_PERMISSIONS.filter(isReadPermission);

/**
 * Tier → permissions. ORG_ADMIN ⊃ PROGRAM_ADMIN ⊃ OBSERVER in what they may
 * do; WHERE they may do it differs (PROGRAM_ADMIN only inside its grants).
 * No tier holds a `platform.*` permission, and OBSERVER is built from the
 * `.read` names only, so a write can never be listed there by hand.
 */
export const TIER_PERMISSIONS: Readonly<Record<AdminTier, ReadonlySet<Permission>>> = Object.freeze({
  ORG_ADMIN: new Set<Permission>(TENANT_PERMISSIONS),
  PROGRAM_ADMIN: new Set<Permission>([
    ...TENANT_READS,
    'program.write',
    'relation.write',
    'pipeline.transition',
  ]),
  OBSERVER: new Set<Permission>(TENANT_READS),
});

/**
 * The tier an account acts with. Only an ADMIN has one, whatever the column
 * says on another role. An ADMIN whose column is still empty acts as
 * ORG_ADMIN: that is what the role has always meant, the deploy backfill
 * (prisma/backfill-admin-level.mjs) writes exactly that, and an admin created
 * between two deploys by a path that does not stamp the column yet (invite,
 * provisioning, role change) must not lose its tenant on the day #1571 moves
 * the routes. Narrowing is the explicit act — setting PROGRAM_ADMIN or
 * OBSERVER — never the absence of a value.
 */
export function adminTierFor(role: string | null | undefined, adminLevel: string | null | undefined): AdminTier | null {
  if (role !== 'ADMIN') return null;
  if (adminLevel == null) return 'ORG_ADMIN';
  return (ADMIN_TIERS as readonly string[]).includes(adminLevel) ? (adminLevel as AdminTier) : null;
}

export interface Actor {
  id: string;
  role: string;
  /** The EFFECTIVE tier — adminTierFor(role, column) — or null for "not an admin". */
  adminLevel: AdminTier | null;
  orgId: string | null;
  companyId: string | null;
  impersonatorId?: string | null;
}

export interface Subject {
  orgId?: string | null;
  cohortId?: string | null;
  companyId?: string | null;
  userId?: string | null;
}

/** One AdminScopeGrant row, as far as the rule needs it. */
export interface ScopeGrant {
  orgId: string;
  cohortId: string | null;
  companyId: string | null;
}

export type DenialReason =
  | 'unknown_permission'
  | 'platform_only'
  | 'impersonating'
  | 'no_tier'
  | 'not_in_tier'
  | 'cross_tenant'
  | 'no_scope'
  | 'unscoped_subject'
  | 'outside_scope';

export type Decision = { allow: true } | { allow: false; reason: DenialReason };

export interface DecideInput {
  actor: Actor;
  permission: string;
  subject?: Subject;
  /**
   * Is the actor a super admin whose world reaches the subject's organization
   * (or, with no subject organization, a super admin of this request's world)?
   * Computed by the caller from src/lib/superAdmin.ts; read for `platform.*` only.
   */
  platformReach?: boolean;
  /** The actor's AdminScopeGrant rows. Read for PROGRAM_ADMIN only. */
  grants?: readonly ScopeGrant[];
  /**
   * A LIST read rather than one subject: a PROGRAM_ADMIN holding at least one
   * grant is let through, and the caller MUST narrow the rows to those grants
   * (requirePermission hands them back). Without a grant it is still refused.
   */
  listing?: boolean;
}

const DENY = (reason: DenialReason): Decision => ({ allow: false, reason });

/** Does one grant cover the subject? A grant naming both narrows to both. */
export function grantCovers(grant: ScopeGrant, subject: Subject): boolean {
  if (!grant.cohortId && !grant.companyId) return false; // names nothing → grants nothing
  if (grant.cohortId && grant.cohortId !== subject.cohortId) return false;
  if (grant.companyId && grant.companyId !== subject.companyId) return false;
  return true;
}

export function decide({ actor, permission, subject, platformReach, grants, listing }: DecideInput): Decision {
  if (!isPermission(permission)) return DENY('unknown_permission');
  const impersonating = Boolean(actor.impersonatorId);

  if (isPlatformPermission(permission)) {
    // Never borrowed through someone else's session, never held by a tier.
    if (impersonating) return DENY('impersonating');
    return platformReach === true ? { allow: true } : DENY('platform_only');
  }

  const tier = actor.adminLevel;
  if (!tier) return DENY('no_tier');
  // An impersonated session keeps reads only — the same line the impersonation
  // write blocks draw (src/app/api/account/route.ts).
  if (impersonating && !isReadPermission(permission)) return DENY('impersonating');

  // No tenant permission crosses a tenant, a super admin's included: the
  // platform powers are the platform.* names above, nothing else.
  if (subject?.orgId != null && subject.orgId !== actor.orgId) return DENY('cross_tenant');

  if (!TIER_PERMISSIONS[tier].has(permission)) return DENY('not_in_tier');

  if (tier === 'PROGRAM_ADMIN') {
    const own = (grants ?? []).filter((g) => g.orgId === actor.orgId);
    if (own.length === 0) return DENY('no_scope');
    if (listing && !subject) return { allow: true };
    if (!subject || (!subject.cohortId && !subject.companyId)) return DENY('unscoped_subject');
    return own.some((g) => grantCovers(g, subject)) ? { allow: true } : DENY('outside_scope');
  }

  return { allow: true };
}
