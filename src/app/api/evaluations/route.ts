import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { z } from 'zod';
import { EVALUATION_TYPES } from '@/lib/evaluation';
import { allowedCriterionKeys, criteriaByTemplate, resolveTemplateId } from '@/lib/evaluationTemplates';
import { dispatchWebhook } from '@/lib/webhooks';
import { notifyIfAllowed } from '@/lib/notify';

// GET ?relationId= — evaluations for a relation (participants/admin).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
  const searchParams = new URL(request.url).searchParams;
  if (searchParams.has('userId')) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  if (searchParams.get('received') === '1') {
    if (session.user.role !== 'MENTOR') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const received = await prisma.evaluation.findMany({
      where: { relation: { mentorId: session.user.id } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        authorId: true,
        type: true,
        scores: true,
        comment: true,
        createdAt: true,
        relation: { select: { menteeId: true, mentee: { select: { id: true, fullName: true } } } },
      },
    });

    return NextResponse.json({
      evaluations: received.flatMap((e) => {
        if (!e.relation || e.authorId !== e.relation.menteeId) return [];
        return [{
          id: e.id,
          type: e.type,
          scores: e.scores,
          comment: e.comment,
          createdAt: e.createdAt,
          direction: 'MENTEE_ON_MENTOR',
          mentee: e.relation.mentee,
        }];
      }),
    });
  }

  const relationId = searchParams.get('relationId') || '';

  const rel = await prisma.mentorshipRelation.findUnique({ where: { id: relationId } });
  if (!rel) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const allowed = session.user.role === 'ADMIN' || rel.mentorId === session.user.id || rel.menteeId === session.user.id;
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const evaluations = await prisma.evaluation.findMany({ where: { relationId }, orderBy: { createdAt: 'desc' } });
  // The rubric each historical evaluation was scored against (#822), including
  // criteria since retired — a record has to keep rendering with the labels of
  // its own era, not with whatever the org's framework says today. Rows with no
  // templateId used the built-ins and need nothing here.
  const templates = await criteriaByTemplate(
    evaluations.map((e) => e.templateId).filter((id): id is string => !!id)
  );
  // Tag each evaluation with its direction so the UI can pick the right rubric,
  // and with whether the viewer may remove it (author or admin) so the panel
  // only offers a delete button where the DELETE route would actually allow it.
  return NextResponse.json({
    evaluations: evaluations.map((e) => ({
      ...e,
      direction: e.authorId === rel.menteeId ? 'MENTEE_ON_MENTOR' : 'MENTOR_ON_MENTEE',
      canDelete: e.authorId === session.user.id || session.user.role === 'ADMIN',
    })),
    templates,
  });
  });
}

// The key whitelist is no longer a compile-time constant: an org may have
// defined its own criteria (#822), so the shape is validated here and the keys
// against the tenant's resolved set inside the handler.
const scoreSchema = z.record(z.string().min(1).max(64), z.number().int().min(1).max(5));
const schema = z.object({
  relationId: z.string().min(1),
  type: z.enum(EVALUATION_TYPES).optional(),
  scores: scoreSchema,
  comment: z.string().max(2000).optional().nullable(),
});

// POST — record an evaluation. Mentor/admin evaluate the mentee; the mentee can
// evaluate their mentor (two-way). Direction is inferred from the author.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });

  const rel = await prisma.mentorshipRelation.findUnique({ where: { id: parsed.data.relationId } });
  if (!rel) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const isParticipant = rel.mentorId === session.user.id || rel.menteeId === session.user.id;
  if (session.user.role !== 'ADMIN' && !isParticipant) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Which side is being scored decides the rubric: the mentee writing means the
  // MENTOR is evaluated, anyone else means the MENTEE is.
  const scope = session.user.id === rel.menteeId ? 'MENTOR' : 'MENTEE';
  const allowed = await allowedCriterionKeys(rel.orgId);
  const unknown = Object.keys(parsed.data.scores).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: 'Validation failed', details: { formErrors: [`Unknown criteria: ${unknown.join(', ')}`] } },
      { status: 400 }
    );
  }

  const evaluation = await prisma.evaluation.create({
    data: {
      relationId: rel.id,
      authorId: session.user.id,
      type: parsed.data.type ?? 'INTERIM',
      scores: parsed.data.scores,
      comment: parsed.data.comment || null,
      // Null when the org uses the built-in rubric — the overwhelming case, and
      // what every pre-#822 row already looks like.
      templateId: await resolveTemplateId(rel.orgId, scope),
    },
  });
  await dispatchWebhook('evaluation.added', { relationId: rel.id, type: evaluation.type, authorId: session.user.id });
  // The evaluated side learns an evaluation exists (#925): mentee wrote it →
  // mentor is told, mentor/admin wrote it → mentee is told. Privacy rule: the
  // notification (which can surface on a lock screen via browser notifications)
  // carries NO scores and NO comment text — just the fact, and a link to the
  // page that shows it behind a session.
  const recipientId = session.user.id === rel.menteeId ? rel.mentorId : rel.menteeId;
  if (recipientId !== session.user.id) {
    const link = recipientId === rel.menteeId ? '/portal' : `/mentor/mentees/${rel.id}`;
    await notifyIfAllowed(recipientId, 'goalsEvaluations', 'evaluation.added', {}, link);
  }
  return NextResponse.json({ evaluation }, { status: 201 });
  });
}
