import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { readAgendaTranslations } from '@/lib/agendasRule';

// The guide library as the agenda picker sees it (#1843): the tenant's live
// (non-archived) templates, most-used first, with their items so the picker
// can preview what a conversation covers. Read-only and for every signed-in
// participant — curation is /api/admin/agenda-templates. Guidance is withheld
// here: it is the mentor's facilitation note, resolved per item on the agenda
// itself, not a library-level fact a mentee needs.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  return await withTenantScope(session, async () => {
    const templates = await prisma.agendaTemplate.findMany({
      where: withinTenant({ archivedAt: null }, await tenantWhere(session)),
      orderBy: [{ useCount: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        title: true,
        translations: true,
        summary: true,
        useCount: true,
        items: { orderBy: { order: 'asc' }, select: { id: true, prompt: true, translations: true } },
      },
    });
    return NextResponse.json({
      templates: templates.map((t) => ({
        id: t.id,
        title: t.title,
        translations: readAgendaTranslations(t.translations),
        summary: readAgendaTranslations(t.summary),
        useCount: t.useCount,
        items: t.items.map((i) => ({ id: i.id, prompt: i.prompt, translations: readAgendaTranslations(i.translations) })),
      })),
    });
  });
}
