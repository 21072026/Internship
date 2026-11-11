import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireRoleOrPermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { readTranslations } from '@/lib/goalTemplates';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';

// The shared to-do pool, readable by whoever hands to-dos out (#1113).
//
// The same pool an admin manages under /admin/goal-templates and a project offers
// on its own page — here without a project, because a mentor gives their mentee
// a to-do whether or not there is a project between them. Retired (archived)
// entries are left out: they exist only to keep the wording of the to-dos already
// handed out from them.
//
// Only the caller's own tenant's pool (cross-world isolation).
export async function GET(request: Request) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  return await withTenantScope(session, async () => {
    const rows = await prisma.projectTaskTemplate.findMany({
      where: withinTenant({ projectId: null, archivedAt: null }, await tenantWhere(session)),
      orderBy: [{ useCount: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, title: true, translations: true, useCount: true },
    });
    return NextResponse.json({
      templates: rows.map((t) => ({
        id: t.id,
        title: t.title,
        translations: readTranslations(t.translations),
        useCount: t.useCount,
        shared: true,
      })),
    });
  });
}
