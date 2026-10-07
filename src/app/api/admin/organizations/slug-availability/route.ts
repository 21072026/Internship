import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { logCrossTenantDenial, superAdminWorld } from '@/lib/superAdmin';
import { orgSlugAvailable } from '@/lib/orgProvisioning';
import { slugifyOrg } from '@/lib/orgSlug';
import { enforceRateLimit } from '@/lib/rateLimit';

// GET ?slug= — is this organization slug free? (#2065) The provisioning wizard
// asks as the name is typed, so a taken slug is reported before submit; create
// checks again inside its transaction, which is the actual guarantee.
//
// Super-admin only, like creating an organization: a slug names a tenant, and
// an endpoint that answers "taken" for anyone would enumerate customers.
// Slugs are global — not per world — because they key the SSO URLs.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const world = await superAdminWorld(session);
  if (!world) {
    await logCrossTenantDenial(session, 'GET /api/admin/organizations/slug-availability', null);
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const limited = enforceRateLimit(request, 'org-slug-availability', { limit: 120, windowMs: 60 * 1000, subject: session.user.id });
  if (limited) return limited;

  const slug = slugifyOrg(new URL(request.url).searchParams.get('slug') ?? '');
  if (!slug) return NextResponse.json({ slug, available: false });
  return NextResponse.json({ slug, available: await orgSlugAvailable(slug) });
}
