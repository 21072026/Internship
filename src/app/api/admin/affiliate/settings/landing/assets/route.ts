import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { storeLandingAsset } from '@/lib/affiliateLandingAssets';

// POST multipart { file } — one picture or video for the public page's theme
// (#3535): PNG/JPEG/WebP ≤ 5 MB or MP4/WebM ≤ 15 MB, bytes checked against the
// declared type. `affiliate.write`, MARKETING only. Answers { id, kind, url };
// the theme then names the id (theme.media) and the landing save checks it.
// Refusals: 400 `missing` | `unsupported` | `too_large` | `mismatch`, 409 `too_many`.
export async function POST(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  const result = await storeLandingAsset(orgId, file instanceof File ? file : null);
  if (!result.ok) return NextResponse.json({ code: result.reason }, { status: result.reason === 'too_many' ? 409 : 400 });
  return NextResponse.json({ id: result.id, kind: result.kind, url: result.url }, { status: 201 });
}
