import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requestHostHeader, resolvePublicInquiryTarget } from '@/lib/publicHostOrg';
import { loadPublicEmployer } from '@/lib/employerPageStore';

// GET /api/public/employers/[slug] (#1867, docs/employer-page.md) — the public
// employer page's data, unauthenticated. The tenant is the HOST's (the public
// form rule, src/lib/publicHostOrg.ts) — a slug is unique per tenant, never
// globally. 404 unless the company opted in AND is verified: an unpublished,
// pending or suspended company does not exist at this URL. The payload is
// `loadPublicEmployer()`'s select and nothing else — no contact e-mail, no
// address.
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const limited = enforceRateLimit(request, 'public-employer', { limit: 120, windowMs: 60 * 1000 });
  if (limited) return limited;
  const target = await resolvePublicInquiryTarget(requestHostHeader(request.headers));
  if (!target.open || target.vertical !== 'INTERNSHIP' || !target.orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { slug } = await params;
  const employer = await loadPublicEmployer(target.orgId, slug);
  if (!employer) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ employer });
}
