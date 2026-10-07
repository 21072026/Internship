import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { instantiateAgenda } from '@/lib/agendas';
import { agendaIfAllowed, agendaInclude, announceAgendaChange, serializeAgenda, viewerOf } from '@/lib/agendaAccess';

const schema = z.object({
  // Start the next session from a guide too; its lines come first, the
  // carried ones after.
  templateId: z.string().min(1).optional(),
  meetingId: z.string().min(1).optional(),
});

// POST — carry what was not finished into the next session (#1843): a new
// agenda on the same pairing holding a copy of every unticked line, each
// marked with the line it continues (`carriedFromItemId`) and keeping its
// template reference so the wording still resolves live. The source agenda is
// left exactly as it was — it is the record of that session.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const source = await agendaIfAllowed(session, id);
    if (source === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!source) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (menteeWriteClosed(source.relation, session.user.id)) {
      return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });
    }
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const { templateId, meetingId } = parsed.data;

    const open = source.items.filter((item) => !item.done);
    if (open.length === 0) {
      return NextResponse.json({ error: 'Every line of this agenda is done', code: 'nothing_to_carry' }, { status: 400 });
    }
    if (meetingId) {
      const meeting = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { relationId: true } });
      if (!meeting || meeting.relationId !== source.relationId) {
        return NextResponse.json({ error: 'Meeting is not part of this mentorship' }, { status: 400 });
      }
      const taken = await prisma.sessionAgenda.findUnique({ where: { meetingId }, select: { id: true } });
      if (taken) return NextResponse.json({ error: 'That meeting already has an agenda', code: 'agenda_exists' }, { status: 409 });
    }

    let nextId: string;
    if (templateId) {
      const created = await instantiateAgenda({
        relationId: source.relationId,
        templateId,
        meetingId: meetingId ?? null,
        createdById: session.user.id,
      });
      if (!created) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
      nextId = created.id;
    } else {
      const created = await prisma.sessionAgenda.create({
        data: { relationId: source.relationId, meetingId: meetingId ?? null, createdById: session.user.id },
        select: { id: true },
      });
      nextId = created.id;
    }

    const existing = await prisma.sessionAgendaItem.count({ where: { agendaId: nextId } });
    await prisma.sessionAgendaItem.createMany({
      data: open.map((item, index) => ({
        agendaId: nextId,
        order: existing + index,
        text: item.text,
        templateItemId: item.templateItemId,
        carriedFromItemId: item.id,
      })),
    });

    const next = await prisma.sessionAgenda.findUniqueOrThrow({ where: { id: nextId }, include: agendaInclude });
    announceAgendaChange(source.relation, source.relationId, session.user.id);
    return NextResponse.json(
      { agenda: serializeAgenda(next, source.relation, viewerOf(session)), carried: open.length },
      { status: 201 }
    );
  });
}
