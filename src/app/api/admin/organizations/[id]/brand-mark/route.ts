import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { orgAdminRefusal } from '@/lib/orgAdminGate';
import { orgPlanHasFeature, planIncludingFeature } from '@/lib/orgPlans';
import { BRAND_MARK_MAX_BYTES, classifyMarkUpload, removeBrandMark, storeBrandMark } from '@/lib/brandAssets';
import { brandAssetPath } from '@/lib/brandRule';
import { enforceRateLimit } from '@/lib/rateLimit';

// /api/admin/organizations/[id]/brand-mark (#2922) — an organization's logo
// mark, from which every app icon, launch image and the in-app mark are
// generated (src/lib/brandAssets.ts, docs/white-label.md).
//
// WHO: exactly the door of PATCH /api/admin/organizations for branding — that
// organization's ADMIN, or a super admin of its world (orgAdminGate, refused
// before the target is looked up, cross-tenant tries logged). Uploading is the
// plan's WHITE_LABEL feature; REMOVING is always allowed, for the reason the
// PATCH exempts a pure clear: a brand bought once must not render forever just
// because the plan lapsed.
//
// WHAT: one square mark — SVG (strictly validated, rasterized, never served),
// or PNG/WebP of at least 512 px — at most 2 MB. The bytes decide the type;
// the declared type only has to agree with them.
//
// COST: rendering an upload is the most expensive thing an admin can ask of the
// server, so it is bounded three ways — a per-admin rate limit here, one render
// at a time per process (a second concurrent upload answers 503 'busy'), and a
// hard wall-clock deadline on the child process that decodes the file
// (glyphMaster, src/lib/brandRender.ts).

const ROUTE = '/api/admin/organizations/[id]/brand-mark';

function featureLocked() {
  return NextResponse.json(
    {
      code: 'feature_locked',
      feature: 'WHITE_LABEL',
      requiredPlan: planIncludingFeature('WHITE_LABEL'),
      error: 'This feature (WHITE_LABEL) is not included in the organization\'s current plan',
    },
    { status: 403 },
  );
}

function refused(reason: string, status = 400) {
  return NextResponse.json({ code: 'mark_refused', reason, error: `The mark was not accepted (${reason}).` }, { status });
}

// POST (multipart, field `file`) — replace the organization's mark.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const refusal = await orgAdminRefusal(session, id, `POST ${ROUTE}`);
  if (refusal) return refusal;
  const limited = enforceRateLimit(request, 'brand-mark-upload', { limit: 10, windowMs: 10 * 60 * 1000, subject: session.user.id });
  if (limited) return limited;

  const org = await prisma.organization.findUnique({
    where: { id },
    select: { id: true, plan: true, vertical: true, brandTileColor: true, brandColor: true },
  });
  if (!org) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  if (!orgPlanHasFeature(org.plan, 'WHITE_LABEL')) return featureLocked();

  // A declared length past the cap is refused before the body is read at all.
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > BRAND_MARK_MAX_BYTES + 64 * 1024) return refused('too_large', 413);

  let file: FormDataEntryValue | null = null;
  try {
    file = (await request.formData()).get('file');
  } catch {
    return refused('missing');
  }
  if (!(file instanceof File)) return refused('missing');
  if (file.size > BRAND_MARK_MAX_BYTES) return refused('too_large', 413);

  const bytes = Buffer.from(await file.arrayBuffer());
  const kind = classifyMarkUpload(bytes, file.type);
  if (!kind.ok) return refused(kind.reason, kind.reason === 'too_large' ? 413 : 400);

  const stored = await storeBrandMark(org, { bytes, kind: kind.kind, contentType: kind.contentType });
  if (!stored.ok) {
    if (stored.reason === 'busy') {
      return NextResponse.json(
        { code: 'mark_refused', reason: 'busy', error: 'Another mark is being rendered; try again in a moment.' },
        { status: 503, headers: { 'Retry-After': '15' } },
      );
    }
    return refused(stored.reason);
  }

  await logActivity({
    action: 'org.brand_mark_uploaded',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'organization',
    targetId: id,
    detail: `${kind.kind} ${bytes.length} bytes → ${stored.version}`,
    request,
  });
  return NextResponse.json({ version: stored.version, markUrl: brandAssetPath(stored.version, 'mark-128') });
}

// DELETE — remove the organization's mark; its icons fall back to the defaults.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const refusal = await orgAdminRefusal(session, id, `DELETE ${ROUTE}`);
  if (refusal) return refusal;

  await removeBrandMark(id);
  await logActivity({
    action: 'org.brand_mark_removed',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'organization',
    targetId: id,
    request,
  });
  return NextResponse.json({ ok: true });
}
