import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { agendaIfAllowed, announceAgendaChange, serializeAgenda, viewerOf } from '@/lib/agendaAccess';

// One session agenda (#1843). 'missing' is a 404 for a stranger's tenant too,
// so the id confirms nothing (#2542); a tenant-mate outside the pairing gets 403.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const agenda = await agendaIfAllowed(session, id);
    if (agenda === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!agenda) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return NextResponse.json({ agenda: serializeAgenda(agenda, agenda.relation, viewerOf(session)) });
  });
}

// DELETE — remove an agenda and its items. Participants/admin; the mentee of a
// finished mentorship gets the usual 409.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const agenda = await agendaIfAllowed(session, id);
    if (agenda === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!agenda) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (menteeWriteClosed(agenda.relation, session.user.id)) {
      return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });
    }
    await prisma.sessionAgenda.delete({ where: { id } }).catch(() => null);
    announceAgendaChange(agenda.relation, agenda.relationId, session.user.id);
    return NextResponse.json({ ok: true });
  });
}
