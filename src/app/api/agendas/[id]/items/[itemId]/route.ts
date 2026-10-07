import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { agendaIfAllowed, agendaInclude, announceAgendaChange, serializeAgenda, viewerOf } from '@/lib/agendaAccess';

const patchSchema = z
  .object({
    done: z.boolean().optional(),
    // Only an ad-hoc line has its own wording; a templated line reads the guide.
    text: z.string().trim().min(1).max(TEXT_LIMITS.agendaItemText).optional(),
    order: z.number().int().min(0).optional(),
  })
  .refine((v) => v.done !== undefined || v.text !== undefined || v.order !== undefined, { message: 'empty' });

// The item must belong to THIS agenda: an item id from another agenda the
// caller may also see must not be reachable through this URL.
async function load(session: Parameters<typeof agendaIfAllowed>[0], agendaId: string, itemId: string) {
  const agenda = await agendaIfAllowed(session, agendaId);
  if (agenda === 'missing' || !agenda) return { agenda, item: null };
  const item = agenda.items.find((i) => i.id === itemId) ?? null;
  return { agenda, item };
}

// PATCH — tick/untick, reword an ad-hoc line, or move it (#1843).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id, itemId } = await params;
  return await withTenantScope(session, async () => {
    const { agenda, item } = await load(session, id, itemId);
    if (agenda === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!agenda) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (menteeWriteClosed(agenda.relation, session.user.id)) {
      return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });
    }
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const { done, text, order } = parsed.data;
    if (text !== undefined && item.templateItemId) {
      return NextResponse.json({ error: 'A templated line reads its wording from the guide', code: 'templated' }, { status: 400 });
    }

    await prisma.sessionAgendaItem.update({
      where: { id: item.id },
      data: {
        ...(done !== undefined ? { done, doneAt: done ? new Date() : null } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(order !== undefined ? { order } : {}),
      },
    });
    const updated = await prisma.sessionAgenda.findUniqueOrThrow({ where: { id: agenda.id }, include: agendaInclude });
    announceAgendaChange(agenda.relation, agenda.relationId, session.user.id);
    return NextResponse.json({ agenda: serializeAgenda(updated, agenda.relation, viewerOf(session)) });
  });
}

// DELETE — drop a line from the agenda.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id, itemId } = await params;
  return await withTenantScope(session, async () => {
    const { agenda, item } = await load(session, id, itemId);
    if (agenda === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!agenda) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (menteeWriteClosed(agenda.relation, session.user.id)) {
      return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });
    }
    await prisma.sessionAgendaItem.delete({ where: { id: item.id } }).catch(() => null);
    const updated = await prisma.sessionAgenda.findUniqueOrThrow({ where: { id: agenda.id }, include: agendaInclude });
    announceAgendaChange(agenda.relation, agenda.relationId, session.user.id);
    return NextResponse.json({ agenda: serializeAgenda(updated, agenda.relation, viewerOf(session)) });
  });
}
