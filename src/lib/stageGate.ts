// Stage entry gates (#1589) — the server half. Server-only (Prisma).
//
// canTransition() is the ONE answer to "may this relation move into this
// stage now?", asked BEFORE anything is written by every path a person or an
// integration moves a stage through: PUT /api/mentorship/[id] (the board, the
// candidate page), the bulk advance (per row) and PATCH
// /api/v1/relationships/[id]/stage. null means allowed. Which moves are gated
// at all, and the fail-closed rule for an unknown capability, are pure in
// src/lib/stageGateRule.ts; this file only reads the evidence.
//
// Never gated: a stage with no configured gate (the default for every tenant),
// a backwards move, a move into an off-path stage, a COACHING relation
// (internship documents and offers mean nothing there, #1503). The checks run
// in a fixed order — capability, documents, evaluation, offer — and the first
// one that fails is the answer, so the mover sees one thing to fix at a time.

import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import type { Locale } from '@/i18n/config';
import { can } from '@/lib/authz';
import type { Actor } from '@/lib/authzRule';
import { missingRequirementsAtStage } from '@/lib/documentRequirements';
import { GATE_OFFER_STATUSES, gateCapability, gatedTarget, type GateFailure, type GateStage } from '@/lib/stageGateRule';

export type { GateFailure } from '@/lib/stageGateRule';

/**
 * Who is moving the relation. An API key is an integration an ORG_ADMIN minted
 * with `relationships:write` — that scope IS its capability, so only the entry
 * conditions apply to it.
 */
export type GateActor = { actor: Actor | null; session?: Session | null } | { apiKey: true };

export interface GateRelation {
  id: string;
  orgId: string | null;
  menteeId: string;
  cohortId?: string | null;
  companyId?: string | null;
  kind?: string | null;
  pipelineStatus: string;
}

/** The tenant's stage rows with their gates; an org on the built-in stages has none, so nothing is gated. */
async function gateStages(orgId: string | null): Promise<GateStage[]> {
  if (!orgId) return [];
  return prisma.pipelineStage.findMany({
    where: { orgId },
    select: { key: true, order: true, isOffPath: true, gateCapability: true, gateDocuments: true, gateEvaluation: true, gateOffer: true },
  });
}

/** A per-org cache of the stage rows for a caller that judges many relations (the bulk advance). */
export function createStageGateCache(): (orgId: string | null) => Promise<GateStage[]> {
  const cache = new Map<string, Promise<GateStage[]>>();
  return (orgId) => {
    const key = orgId ?? '';
    let hit = cache.get(key);
    if (!hit) {
      hit = gateStages(orgId);
      cache.set(key, hit);
    }
    return hit;
  };
}

export async function canTransition(
  who: GateActor,
  relation: GateRelation,
  to: string,
  locale: Locale,
  stagesOf: (orgId: string | null) => Promise<GateStage[]> = gateStages,
): Promise<GateFailure | null> {
  if (relation.kind === 'COACHING') return null;
  const target = gatedTarget(await stagesOf(relation.orgId), relation.pipelineStatus, to);
  if (!target) return null;

  const capability = gateCapability(target);
  if (capability && !('apiKey' in who)) {
    // No live actor (an account deactivated mid-session) never holds a capability.
    const allowed =
      capability !== 'invalid' &&
      !!who.actor &&
      (await can(
        who.actor,
        capability,
        { orgId: relation.orgId, cohortId: relation.cohortId ?? null, companyId: relation.companyId ?? null, userId: relation.menteeId },
        who.session,
      ));
    if (!allowed) return { code: 'capability', stage: to, missing: [{ key: target.gateCapability!, label: target.gateCapability! }] };
  } else if (capability === 'invalid') {
    return { code: 'capability', stage: to, missing: [{ key: target.gateCapability!, label: target.gateCapability! }] };
  }

  if (target.gateDocuments) {
    const missing = await missingRequirementsAtStage(relation.menteeId, to, locale);
    if (missing.length > 0) return { code: 'documents', stage: to, missing: missing.map((m) => ({ key: m.key, label: m.label })) };
  }

  if (target.gateEvaluation) {
    const evaluation = await prisma.evaluation.findFirst({
      where: { relationId: relation.id, submittedAt: { not: null } },
      select: { id: true },
    });
    if (!evaluation) return { code: 'evaluation', stage: to };
  }

  if (target.gateOffer) {
    const offer = await prisma.offer.findFirst({
      where: { relationId: relation.id, status: { in: [...GATE_OFFER_STATUSES] } },
      select: { id: true },
    });
    if (!offer) return { code: 'offer', stage: to };
  }

  return null;
}
