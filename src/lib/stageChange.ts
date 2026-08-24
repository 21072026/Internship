// Server-only validation shared by every pipeline-stage write path (#810):
// /api/status-changes, /api/mentorship/[id] (also what the board drag/drop and
// the candidate-detail stage select call), and /api/admin/candidates/bulk's
// advanceStage action. One function, one rule, so no write path can drift from
// another or forget the check.
//
// "Negative stage" is never a hardcoded key list — it is whatever the org's
// OWN resolved pipeline marks isOffPath (src/lib/pipelineStages.ts), which
// already covers per-tenant custom pipelines (#747). No new PipelineStage
// metadata was needed: isOffPath already means exactly this ("left the normal
// flow"), which is what a drop-off reason is about.

import { resolvePipelineStages } from './pipelineStages';
import { isDropoffReasonCode } from './dropoffReasons';

export function isStageTransition(fromStatus: string, toStatus: string): boolean {
  return fromStatus !== toStatus;
}

export async function isNegativeStage(orgId: string | null | undefined, stageKey: string): Promise<boolean> {
  const stages = await resolvePipelineStages(orgId);
  return stages.find((s) => s.key === stageKey)?.isOffPath ?? false;
}

export interface DropoffReasonInput {
  orgId: string | null | undefined;
  toStatus: string;
  reasonCode?: string | null;
  reasonNote?: string | null;
}

export type DropoffReasonValidation = { ok: true } | { ok: false; error: string };

// Called before every StatusChange write that carries a `toStatus`. A move
// into a non-negative stage never requires anything. A move into a negative
// stage requires a whitelisted reasonCode; OTHER additionally requires a
// non-empty reasonNote.
export async function validateDropoffReason(input: DropoffReasonInput): Promise<DropoffReasonValidation> {
  const negative = await isNegativeStage(input.orgId, input.toStatus);
  if (!negative) return { ok: true };

  if (!input.reasonCode) {
    return { ok: false, error: 'reasonCode is required when moving into a negative/off-path stage' };
  }
  if (!isDropoffReasonCode(input.reasonCode)) {
    return { ok: false, error: 'Unknown reasonCode' };
  }
  if (input.reasonCode === 'OTHER' && !input.reasonNote?.trim()) {
    return { ok: false, error: 'reasonNote is required when reasonCode is OTHER' };
  }
  return { ok: true };
}
