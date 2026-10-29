import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { isSavedViewSurface, MAX_VIEW_NAME, SAVED_VIEW_SURFACES, SAVED_VIEW_VISIBILITIES, sanitizeViewFilters, toSavedViewDto as toDto } from '@/lib/savedViews';
import { requirePermission } from '@/lib/authz';

// Saved views on admin lists (#1900). ADMIN only, the caller's own tenant.
// GET lists the views of one surface the caller may see: their own, and every
// view an admin of the org shared (ORG). POST saves one of the caller's own —
// the same name on the same surface replaces it, as the old localStorage
// presets did. Editing and deleting are /api/admin/saved-views/[id].

const createSchema = z.object({
  surface: z.enum(SAVED_VIEW_SURFACES),
  name: z.string().trim().min(1).max(MAX_VIEW_NAME),
  filters: z.record(z.string(), z.unknown()),
  visibility: z.enum(SAVED_VIEW_VISIBILITIES).default('PRIVATE'),
});

const VIEW_SELECT = { id: true, name: true, filters: true, visibility: true, createdById: true, createdBy: { select: { fullName: true } } } as const;

export async function GET(request: Request) {
  const gate = await requirePermission('content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const surface = new URL(request.url).searchParams.get('surface');
  if (!isSavedViewSurface(surface)) return NextResponse.json({ error: 'unknown_surface' }, { status: 400 });
  return withTenantScope(session, async () => {
    const views = await prisma.savedView.findMany({
      where: withinTenant({ surface, OR: [{ createdById: session.user.id }, { visibility: 'ORG' }] }, await tenantWhere(session)),
      orderBy: [{ name: 'asc' }],
      select: VIEW_SELECT,
    });
    return NextResponse.json({ views: views.map((v) => toDto(v, session.user.id)) });
  });
}

export async function POST(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  const { surface, name, visibility } = parsed.data;
  const filters = sanitizeViewFilters(parsed.data.filters);
  return withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    // Same author, surface and name → replace (the unique cannot match a NULL
    // org, so look it up instead of upserting on it).
    const existing = await prisma.savedView.findFirst({
      where: withinTenant({ surface, name, createdById: session.user.id }, await tenantWhere(session)),
      select: { id: true },
    });
    const view = existing
      ? await prisma.savedView.update({ where: { id: existing.id }, data: { filters, visibility }, select: VIEW_SELECT })
      : await prisma.savedView.create({ data: { orgId, surface, name, filters, visibility, createdById: session.user.id }, select: VIEW_SELECT });
    return NextResponse.json({ view: toDto(view, session.user.id) }, { status: existing ? 200 : 201 });
  });
}
