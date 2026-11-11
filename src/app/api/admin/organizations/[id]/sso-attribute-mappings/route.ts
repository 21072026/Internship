import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { recordOrgWrite } from '@/lib/orgAudit';
import { orgPlanHasFeature } from '@/lib/orgPlans';
import { isSuperAdminFor, logCrossTenantDenial } from '@/lib/superAdmin';
import { resolveOrgId } from '@/lib/orgScope';
import { attributeKeyOf, isSyncTarget, SSO_PHOTO_TARGET, SSO_PROFILE_FIELDS } from '@/lib/ssoDirectorySyncRule';
import { requirePermission, type Permission } from '@/lib/authz';

// A tenant's SSO directory sync (#1943): "the IdP claim `claim` refreshes
// `target` on every sign-in", plus the `ssoAuthoritative` switch. The rule
// that reads these rows is src/lib/ssoDirectorySyncRule.ts; completeSsoSignIn()
// applies it for both protocols. docs/sso-saml.md § Directory sync.
//
// WHO MAY WRITE: exactly who may write the org's role mapping — its own ADMIN,
// or a super admin of its world. The refusal comes before the lookup, so a
// foreign id is never confirmed (the sibling sso-role-mappings route's rule).
//
// ONLY ALLOWLISTED TARGETS. A target is a profile field, the photo, or
// `attr:<key>` of an attribute THIS org defined — never email, role or orgId:
// identity and access are provisioning's and the role mapping's.
//
// Not wrapped in withTenantScope (a super admin manages another tenant by
// explicit id). Every query names `orgId: id`.

async function orgSettingsGate(id: string, route: string, permission: Permission, request: Request) {
  const gate = await requirePermission(permission, { request });
  if ('error' in gate) return gate;
  const { session } = gate;
  if (!(await isSuperAdminFor(session, id))) {
    const ownOrgId = resolveOrgId(session);
    if (!ownOrgId || ownOrgId !== id) {
      await logCrossTenantDenial(session, route, id);
      return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
  }
  const org = await prisma.organization.findUnique({
    where: { id },
    select: { id: true, plan: true, ssoAuthoritative: true },
  });
  if (!org) return { error: NextResponse.json({ error: 'Organization not found' }, { status: 404 }) };
  return { org, session };
}

const mappingSelect = { id: true, claim: true, target: true, createdAt: true } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await orgSettingsGate(id, 'GET /api/admin/organizations/[id]/sso-attribute-mappings', 'org.settings.read', request);
  if ('error' in gate) return gate.error;
  const [mappings, attributes, lastSync] = await Promise.all([
    prisma.ssoAttributeMapping.findMany({ where: { orgId: id }, orderBy: { createdAt: 'asc' }, select: mappingSelect }),
    prisma.orgAttribute.findMany({ where: { orgId: id, appliesTo: 'USER' }, orderBy: { sortOrder: 'asc' }, select: { key: true, labelEn: true, labelTr: true, labelDe: true } }),
    // The admin's view of "is it working": the latest sync of this org and
    // how many accounts carry an unresolved problem — codes, never values.
    prisma.user.findFirst({ where: { orgId: id, ssoLastSyncedAt: { not: null } }, orderBy: { ssoLastSyncedAt: 'desc' }, select: { ssoLastSyncedAt: true } }),
  ]);
  const syncErrors = await prisma.user.findMany({
    where: { orgId: id, ssoSyncError: { not: null } },
    orderBy: { ssoLastSyncedAt: 'desc' },
    take: 10,
    select: { id: true, email: true, ssoSyncError: true, ssoLastSyncedAt: true },
  });
  const withErrors = await prisma.user.count({ where: { orgId: id, ssoSyncError: { not: null } } });
  return NextResponse.json({
    mappings,
    authoritative: gate.org.ssoAuthoritative,
    targets: [...SSO_PROFILE_FIELDS, SSO_PHOTO_TARGET],
    attributes,
    lastSyncedAt: lastSync?.ssoLastSyncedAt ?? null,
    accountsWithSyncErrors: withErrors,
    syncErrors,
  });
}

const createSchema = z.object({
  claim: z.string().trim().min(1).max(191),
  target: z.string().trim().min(1).max(80),
}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await orgSettingsGate(id, 'POST /api/admin/organizations/[id]/sso-attribute-mappings', 'org.settings.write', request);
  if ('error' in gate) return gate.error;
  if (!orgPlanHasFeature(gate.org.plan, 'SSO_SAML')) {
    return NextResponse.json({ error: 'SSO is not part of this plan', code: 'plan_feature_required' }, { status: 403 });
  }
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { claim, target } = parsed.data;
  if (!isSyncTarget(target)) {
    return NextResponse.json({ error: 'That field cannot be synced from the IdP.', code: 'invalid_target' }, { status: 400 });
  }
  const key = attributeKeyOf(target);
  if (key && !(await prisma.orgAttribute.findFirst({ where: { orgId: id, key, appliesTo: 'USER' }, select: { id: true } }))) {
    return NextResponse.json({ error: 'This organization has no such attribute.', code: 'unknown_attribute' }, { status: 400 });
  }
  try {
    const mapping = await prisma.ssoAttributeMapping.create({ data: { orgId: id, claim, target }, select: mappingSelect });
    await recordOrgWrite({
      orgId: id,
      action: 'sso.attribute_mapping_created',
      actorId: gate.session.user.id,
      actorEmail: gate.session.user.email ?? null,
      targetType: 'ssoAttributeMapping',
      targetId: mapping.id,
      detail: `${claim} -> ${target}`,
      request,
    });
    return NextResponse.json({ mapping }, { status: 201 });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return NextResponse.json({ error: 'That field is already mapped', code: 'duplicate_mapping' }, { status: 409 });
    }
    throw e;
  }
}

const patchSchema = z.object({ authoritative: z.boolean() }).strict();

// PATCH — Organization.ssoAuthoritative: may the IdP overwrite a value the
// user (or an admin) set? Off = it fills empty fields only.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await orgSettingsGate(id, 'PATCH /api/admin/organizations/[id]/sso-attribute-mappings', 'org.settings.write', request);
  if ('error' in gate) return gate.error;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  if (parsed.data.authoritative && !orgPlanHasFeature(gate.org.plan, 'SSO_SAML')) {
    return NextResponse.json({ error: 'SSO is not part of this plan', code: 'plan_feature_required' }, { status: 403 });
  }
  await prisma.organization.update({ where: { id }, data: { ssoAuthoritative: parsed.data.authoritative } });
  await recordOrgWrite({
    orgId: id,
    action: 'sso.directory_authority_toggled',
    level: 'warning',
    actorId: gate.session.user.id,
    actorEmail: gate.session.user.email ?? null,
    detail: `ssoAuthoritative ${gate.org.ssoAuthoritative} -> ${parsed.data.authoritative}`,
    request,
  });
  return NextResponse.json({ authoritative: parsed.data.authoritative });
}

// DELETE ?mappingId= — stop syncing one field. Values already written stay:
// removing a mapping is not an instruction to blank a profile.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await orgSettingsGate(id, 'DELETE /api/admin/organizations/[id]/sso-attribute-mappings', 'org.settings.write', request);
  if ('error' in gate) return gate.error;
  const mappingId = new URL(request.url).searchParams.get('mappingId');
  if (!mappingId) return NextResponse.json({ error: 'mappingId is required' }, { status: 400 });
  const removed = await prisma.ssoAttributeMapping.deleteMany({ where: { id: mappingId, orgId: id } });
  if (removed.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await recordOrgWrite({
    orgId: id,
    action: 'sso.attribute_mapping_deleted',
    actorId: gate.session.user.id,
    actorEmail: gate.session.user.email ?? null,
    targetType: 'ssoAttributeMapping',
    targetId: mappingId,
    request,
  });
  return NextResponse.json({ ok: true });
}
