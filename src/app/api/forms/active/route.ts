import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { FORM_SURFACES, type FormSurface } from '@/lib/forms/definitionRule';
import { activeForms, publicForm } from '@/lib/forms/active';

// The admin-defined questions the caller is asked on one surface (#1803): the
// live version of each form whose audience covers the caller's role, in the
// caller's org. Questions only — never `matchable`, never anyone's answers
// (the caller's own are GET /api/forms/responses).

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const surface = new URL(request.url).searchParams.get('surface');
  if (!surface || !(FORM_SURFACES as readonly string[]).includes(surface)) {
    return NextResponse.json({ error: 'Invalid surface', code: 'invalid_surface' }, { status: 400 });
  }
  return withTenantScope(session, async () => {
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());
    const forms = await activeForms(orgId, surface as FormSurface, session.user.role);
    return NextResponse.json({ forms: forms.map(publicForm) });
  });
}
