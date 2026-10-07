import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { loadAccessibleMeeting } from '@/lib/meetingAccess';
import { instantiateAgenda } from '@/lib/agendas';
import {
  agendaInclude,
  announceAgendaChange,
  relationForAgendas,
  serializeAgenda,
  viewerOf,
} from '@/lib/agendaAccess';

// Session agendas of a mentorship (#1843): the list a pair works through in a
// session, instantiated from the guide library (#1841) or started empty.
//
// Authorization is the relation's (admin, mentor, mentee — relationForAgendas)
// plus the meeting rule when an agenda is pinned to a meeting
// (loadAccessibleMeeting, the same answer the call-token endpoint gives). A
// finished mentorship takes no new agenda from its mentee (#1408, the 409
// `inactive_relation` body every relation panel uses). Free core: no
// entitlement check here, ever — the capability gate below is the vertical's,
// not a plan's.

const createSchema = z.object({
  relationId: z.string().min(1),
  templateId: z.string().min(1).optional(),
  meetingId: z.string().min(1).optional(),
});

// GET ?relationId=  — every agenda of the pairing, newest first.
// GET ?meetingId=   — the one agenda pinned to that meeting (or none).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const sp = new URL(request.url).searchParams;
    const relationId = sp.get('relationId');
    const meetingId = sp.get('meetingId');

    if (meetingId) {
      // The meeting rule decides, then the agenda is read through its relation.
      const meeting = await loadAccessibleMeeting(
        { id: session.user.id, role: session.user.role, orgId: session.user.orgId },
        meetingId
      );
      if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const agenda = await prisma.sessionAgenda.findUnique({
        where: { meetingId },
        include: { ...agendaInclude, relation: { select: { menteeId: true } } },
      });
      return NextResponse.json({
        agendas: agenda ? [serializeAgenda(agenda, agenda.relation, viewerOf(session))] : [],
      });
    }

    if (!relationId) return NextResponse.json({ error: 'relationId or meetingId required' }, { status: 400 });
    const rel = await relationForAgendas(session, relationId);
    if (rel === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const agendas = await prisma.sessionAgenda.findMany({
      where: { relationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: agendaInclude,
    });
    return NextResponse.json({
      agendas: agendas.map((a) => serializeAgenda(a, rel, viewerOf(session))),
      // The panel closes its write controls on an archive the same way the
      // goals panel does; the server refuses regardless (below).
      writable: !menteeWriteClosed(rel, session.user.id),
    });
  });
}

// POST — start a session agenda: from a guide (templateId) or empty.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;

  return await withTenantScope(session, async () => {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const { relationId, templateId, meetingId } = parsed.data;

    const rel = await relationForAgendas(session, relationId);
    if (rel === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (menteeWriteClosed(rel, session.user.id)) {
      return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });
    }

    if (meetingId) {
      const meeting = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { relationId: true } });
      // A meeting of another pairing (or of nobody) is not this agenda's.
      if (!meeting || meeting.relationId !== rel.id) {
        return NextResponse.json({ error: 'Meeting is not part of this mentorship' }, { status: 400 });
      }
      const taken = await prisma.sessionAgenda.findUnique({ where: { meetingId }, select: { id: true } });
      if (taken) return NextResponse.json({ error: 'That meeting already has an agenda', code: 'agenda_exists' }, { status: 409 });
    }

    if (templateId) {
      // The library is the tenant's: a template of another tenant — or a
      // retired one — is not offered, so it answers like a missing one.
      const template = await prisma.agendaTemplate.findUnique({
        where: { id: templateId },
        select: { id: true, orgId: true, archivedAt: true },
      });
      if (!template || template.archivedAt || (template.orgId !== null && template.orgId !== rel.orgId && rel.orgId !== null)) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 });
      }
      const created = await instantiateAgenda({
        relationId: rel.id,
        templateId: template.id,
        meetingId: meetingId ?? null,
        createdById: session.user.id,
      });
      if (!created) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
      const agenda = await prisma.sessionAgenda.findUniqueOrThrow({ where: { id: created.id }, include: agendaInclude });
      announceAgendaChange(rel, rel.id, session.user.id);
      return NextResponse.json({ agenda: serializeAgenda(agenda, rel, viewerOf(session)) }, { status: 201 });
    }

    const agenda = await prisma.sessionAgenda.create({
      data: { relationId: rel.id, meetingId: meetingId ?? null, createdById: session.user.id },
      include: agendaInclude,
    });
    announceAgendaChange(rel, rel.id, session.user.id);
    return NextResponse.json({ agenda: serializeAgenda(agenda, rel, viewerOf(session)) }, { status: 201 });
  });
}
