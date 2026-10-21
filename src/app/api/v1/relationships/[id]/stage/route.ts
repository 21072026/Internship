import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiError, apiNotFound, apiOk } from '@/lib/api/v1';
import { apiWrite, writeOk } from '@/lib/api/v1Write';
import { relationshipSelect, serializeRelationship } from '@/lib/api/v1Resources';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { isStageTransition, validateDropoffReason } from '@/lib/stageChange';
import { recordStageMove, stageMoveData } from '@/lib/stageMove';

// PATCH /api/v1/relationships/{id}/stage (#1996) — move a relationship's
// pipeline stage from another system.
//
// Through the ONE stage write path (#2658, src/lib/stageMove.ts), never a bare
// `pipelineStatus` update: stageMoveData() is the column patch the UI writes,
// recordStageMove() the StatusChange row, the activity entry and the
// notification / `pipeline.stage_change` webhook / SLA effects — so a move made
// by an ATS is exactly as loud as one dragged on the board.
//
// Refusals, all before anything is written:
//   - a stage key the organisation does not have → 422 (keys, not labels)
//   - a move into an off-path stage without a valid reasonCode → 422, the same
//     drop-off rule the UI enforces (validateDropoffReason)
//   - a relationship that is not ACTIVE → 409 invalid_transition with the
//     current stage: a finished relationship's stage is history
//   - the stage changed between the read and the write → 409 stage_conflict
//     (a guarded updateMany, so two writers cannot both move it)
// The stage it already has is a 200 with `changed: false` and no history row.
const schema = z
  .object({
    stage: z.string().trim().min(1).max(60),
    reasonCode: z.string().trim().max(40).optional(),
    reasonNote: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'relationships:write', (key) =>
    apiWrite(request, key, schema, async (body) => {
      const relation = await prisma.mentorshipRelation.findFirst({
        where: { id, orgId: key.orgId },
        select: { id: true, menteeId: true, orgId: true, status: true, pipelineStatus: true, trialStartedAt: true, trialEndsAt: true },
      });
      if (!relation) return apiNotFound();

      const stages = await resolvePipelineStages(key.orgId);
      if (!stages.some((s) => s.key === body.stage)) {
        return apiError(422, 'validation_failed', 'The request body is invalid', undefined, {
          errors: [{ path: 'stage', code: 'unknown_stage', message: `not a stage key of this organisation: ${stages.map((s) => s.key).join(', ')}` }],
        });
      }
      if (relation.status !== 'ACTIVE') {
        return apiError(409, 'invalid_transition', 'The relationship is not active', 'Only an active relationship can change stage.', {
          currentStage: relation.pipelineStatus,
          status: relation.status,
        });
      }
      if (!isStageTransition(relation.pipelineStatus, body.stage)) {
        const unchanged = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id }, select: relationshipSelect });
        return apiOk(serializeRelationship(unchanged), undefined, { changed: false });
      }
      const reason = await validateDropoffReason({ orgId: key.orgId, toStatus: body.stage, reasonCode: body.reasonCode, reasonNote: body.reasonNote });
      if (!reason.ok) {
        return apiError(422, 'validation_failed', 'The request body is invalid', undefined, {
          errors: [{ path: body.reasonCode ? 'reasonNote' : 'reasonCode', code: 'dropoff_reason', message: reason.error }],
        });
      }

      const moved = await prisma.mentorshipRelation.updateMany({
        where: { id, orgId: key.orgId, status: 'ACTIVE', pipelineStatus: relation.pipelineStatus },
        data: await stageMoveData(relation, body.stage),
      });
      if (moved.count === 0) {
        const now = await prisma.mentorshipRelation.findUnique({ where: { id }, select: { pipelineStatus: true } });
        return apiError(409, 'stage_conflict', 'The stage changed meanwhile', 'Read the relationship again and retry.', {
          currentStage: now?.pipelineStatus ?? null,
        });
      }
      await recordStageMove({
        relation,
        toStatus: body.stage,
        // An API key is not a person: the move is recorded as the system's,
        // with the key named in the activity line.
        actor: null,
        reasonCode: body.reasonCode ?? null,
        reasonNote: body.reasonNote ?? null,
        cause: `api key ${key.id}`,
      });

      const updated = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id }, select: relationshipSelect });
      return writeOk(apiOk(serializeRelationship(updated), undefined, { changed: true }), {
        action: 'api.relationship.stage',
        targetType: 'relation',
        targetId: id,
        detail: `${relation.pipelineStatus} → ${body.stage}`,
      });
    }),
  );
}
