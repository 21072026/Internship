import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { isSuperAdmin } from '@/lib/superAdmin';
import { MAX_VIEW_NAME, SAVED_VIEW_VISIBILITIES, sanitizeViewFilters, toSavedViewDto as toDto } from '@/lib/savedViews';
import { requirePermission } from '@/lib/authz';

// One saved view (#1900). Only its author changes or deletes it — whether it is
// PRIVATE or shared with the org — or a super admin. Checked here, in the
// handler: hiding the delete chip is not authorization. Another tenant's view
// answers like a missing one (404); a colleague's view you may not change is
// 403.

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_VIEW_NAME).optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
    visibility: z.enum(SAVED_VIEW_VISIBILITIES).optional(),
  })
  .strict();

async function loadOwned(id: string, session: Parameters<typeof tenantWhere>[0] & { user: { id: string } }) {
  const view = await prisma.savedView.findFirst({ where: withinTenant({ id }, await tenantWhere(session)), select: { id: true, createdById: true } });
  if (!view) return { status: 404 as const };
  if (view.createdById !== session.user.id && !(await isSuperAdmin(session))) return { status: 403 as const };
  return { status: 200 as const, view };
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const owned = await loadOwned(id, session);
    if (owned.status !== 200) return NextResponse.json({ error: owned.status === 404 ? 'Not found' : 'Forbidden' }, { status: owned.status });
    try {
      const view = await prisma.savedView.update({
        where: { id },
        data: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.filters !== undefined ? { filters: sanitizeViewFilters(parsed.data.filters) } : {}),
          ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
        },
        select: { id: true, name: true, filters: true, visibility: true, createdById: true, createdBy: { select: { fullName: true } } },
      });
      return NextResponse.json({ view: toDto(view, session.user.id) });
    } catch (error) {
      // Renamed onto another of the author's views on this surface.
      if ((error as { code?: string })?.code === 'P2002') return NextResponse.json({ error: 'name_taken', code: 'name_taken' }, { status: 409 });
      throw error;
    }
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.write', { request: _request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  return withTenantScope(session, async () => {
    const owned = await loadOwned(id, session);
    if (owned.status !== 200) return NextResponse.json({ error: owned.status === 404 ? 'Not found' : 'Forbidden' }, { status: owned.status });
    await prisma.savedView.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  });
}
