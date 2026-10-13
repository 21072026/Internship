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
import { AGENDA_PROPOSAL_MAX } from '@/lib/aiAgendaRule';

const line = z.string().trim().min(1).max(TEXT_LIMITS.agendaItemText);
// One line, or the lines of an accepted AI proposal (#1845) in one request —
// one write, one realtime signal, instead of a request per line.
const schema = z
  .object({ text: line.optional(), texts: z.array(line).min(1).max(AGENDA_PROPOSAL_MAX).optional() })
  .refine((d) => Boolean(d.text) !== Boolean(d.texts), { message: 'text or texts' });

// POST — add an ad-hoc line to the agenda (#1843), or several at once (an
// accepted proposal, #1845). Either seat may; they land at the end, in order.
// Templated lines come from the guide, never from here.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const last = agenda.items.reduce((max, item) => Math.max(max, item.order), -1);
    const texts = parsed.data.texts ?? [parsed.data.text as string];
    await prisma.sessionAgendaItem.createMany({
      data: texts.map((text, index) => ({ agendaId: agenda.id, order: last + 1 + index, text })),
    });
    const updated = await prisma.sessionAgenda.findUniqueOrThrow({ where: { id: agenda.id }, include: agendaInclude });
    announceAgendaChange(agenda.relation, agenda.relationId, session.user.id);
    return NextResponse.json({ agenda: serializeAgenda(updated, agenda.relation, viewerOf(session)) }, { status: 201 });
  });
}
