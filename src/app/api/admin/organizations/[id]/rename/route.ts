import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { renameOrganization, type RenameResult } from '@/lib/orgLifecycle';
import { ORG_NAME_MAX } from '@/lib/orgLifecycleRule';
import { ORG_SLUG_MAX } from '@/lib/orgSlug';

// POST /api/admin/organizations/[id]/rename (#1582, docs/tenant-lifecycle.md)
// — change a tenant's display name and/or slug. Super admin of the org's world
// only (`platform.org.write`); a tenant ADMIN, its own org included, is refused
// with the denial row requirePermission writes. The rule — the default org's
// slug is fixed, an SSO tenant's slug needs `force` — is orgLifecycleRule.ts.

const bodySchema = z
  .object({
    name: z.string().max(ORG_NAME_MAX * 2).optional(),
    slug: z.string().max(ORG_SLUG_MAX * 2).optional(),
    force: z.boolean().optional(),
  })
  .strict();

const ERRORS: Record<Exclude<RenameResult, { ok: true }>['code'], { status: number; error: string }> = {
  not_found: { status: 404, error: 'Organization not found' },
  nothing_to_change: { status: 400, error: 'Nothing to change' },
  name_invalid: { status: 400, error: `Name must be 1–${ORG_NAME_MAX} characters` },
  slug_invalid: { status: 400, error: 'Could not derive a valid slug' },
  slug_taken: { status: 409, error: 'An organization with that slug already exists' },
  default_org_slug: { status: 409, error: 'The default organization’s slug cannot change' },
  sso_slug_locked: {
    status: 409,
    error:
      'SSO is enabled: the SAML Entity ID and ACS URL are derived from the slug, so a new slug breaks the configured IdP. Reconfigure the IdP first, then resend with force: true.',
  },
  archived: { status: 409, error: 'Unarchive the organization before renaming it' },
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePermission('platform.org.write', { subject: { orgId: id }, request });
  if ('error' in gate) return gate.error;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const result = await renameOrganization(
    id,
    parsed.data,
    { id: gate.actor.id, email: gate.session.user?.email ?? null, orgId: gate.actor.orgId },
    request,
  );
  if (!result.ok) {
    const e = ERRORS[result.code];
    return NextResponse.json({ error: e.error, code: result.code }, { status: e.status });
  }
  return NextResponse.json({ organization: result.organization });
}
