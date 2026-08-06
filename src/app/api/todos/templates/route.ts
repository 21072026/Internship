import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { readTranslations } from '@/lib/goalTemplates';

// The shared to-do pool, readable by whoever hands to-dos out (#1113).
//
// The same pool an admin manages under /admin/goal-templates and a project offers
// on its own page — here without a project, because a mentor gives their mentee
// a to-do whether or not there is a project between them. Retired (archived)
// entries are left out: they exist only to keep the wording of the to-dos already
// handed out from them.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
    const rows = await prisma.projectTaskTemplate.findMany({
      where: { projectId: null, archivedAt: null },
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
