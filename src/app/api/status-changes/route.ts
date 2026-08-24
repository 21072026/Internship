import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { validateDropoffReason } from '@/lib/stageChange';
import { emitStageChange } from '@/lib/stageChangeEffects';

// Stage key is a free string now (#747) so tenant-defined stages are accepted.
const stage = z.string().min(1).max(60);
const schema = z.object({
  relationId: z.string().min(1),
  fromStatus: stage,
  toStatus: stage,
  createdAt: z.string().datetime().optional(),
  // Drop-off reason (#810) — z.string() + a central whitelist (src/lib/dropoffReasons.ts),
  // never z.enum. Required by validateDropoffReason() when toStatus is a
  // negative/off-path stage in the relation's org pipeline.
  reasonCode: z.string().max(40).optional(),
  reasonNote: z.string().max(2000).optional(),
});

// POST — admin manually adds a stage-history entry to correct the audit trail.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }

    const { relationId, fromStatus, toStatus, createdAt, reasonCode, reasonNote } = parsed.data;
    const relation = await prisma.mentorshipRelation.findUnique({ where: { id: relationId } });
    if (!relation) {
      return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
    }

    const reasonCheck = await validateDropoffReason({ orgId: relation.orgId, toStatus, reasonCode, reasonNote });
    if (!reasonCheck.ok) {
      return NextResponse.json({ error: reasonCheck.error }, { status: 400 });
    }

    // A backdated entry is a history correction and must not move the
    // relation's CURRENT stage (it may legitimately describe an old hop the
    // pipeline has long passed). A non-backdated entry is a real stage move
    // (#926): pipelineStatus is updated in the same transaction — the audit
    // row and the live stage can never diverge — and the mentee notification
    // + pipeline.stage_change webhook fire like on every other write path.
    const isBackdated = !!createdAt;
    const applyToRelation = !isBackdated && toStatus !== relation.pipelineStatus;

    const [change] = await prisma.$transaction([
      prisma.statusChange.create({
        data: {
          relationId,
          fromStatus,
          toStatus,
          changedById: session.user.id,
          reasonCode: reasonCode ?? null,
          reasonNote: reasonNote?.trim() || null,
          ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
        },
      }),
      ...(applyToRelation
        ? [prisma.mentorshipRelation.update({ where: { id: relationId }, data: { pipelineStatus: toStatus } })]
        : []),
    ]);

    if (applyToRelation) {
      await emitStageChange({
        relationId,
        menteeId: relation.menteeId,
        orgId: relation.orgId,
        from: relation.pipelineStatus,
        to: toStatus,
        reasonCode,
      });
    }

    return NextResponse.json({ change }, { status: 201 });
  });
}
