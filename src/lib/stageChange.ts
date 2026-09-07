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

// ── The single gate every StatusChange write goes through (#934) ─────────────
//
// A row whose `fromStatus` equals its `toStatus` is not a move: it is noise in
// the one table that is supposed to be a clean record of a person's progress,
// and — quieter but worse — it is arithmetic. `stageEnteredAt()`
// (src/lib/stageClock.ts) takes the newest StatusChange whatever it says, so a
// no-op row silently RESTARTS the stage clock; `computeStageAging()`
// (src/lib/stageAging.ts) reads it as "left stage X, entered stage X" and
// counts two visits where there was one; the mentor analytics "stage moves"
// figure and the activity report both count rows.
//
// This gate stops NEW ones. The rows already in the table stay — #934 decided
// that explicitly ("eski veri geriye dönük temizlenmeyecek"), and a StatusChange
// can carry an admin's own `reasonCode`/`reasonNote`, so no unattended script
// deletes them. The UI already hides them (`isStageTransition` in
// /api/mentorship/[id], /api/users/[id] and lib/relationTimeline.ts); teaching
// the two readers above to skip them as well is #2264.
//
// The guard used to be written out at each write path — three copies of one
// rule, and the bulk "advance stage" action carried none of them (it could not
// reach the case, but nothing said so). Now every caller builds its row here
// and a `null` means "there is nothing to record" — the surrounding operation
// is still a success (see the callers: a request that sets a stage to its
// current value is a silent no-op, never a 400).
export interface StatusChangeInput {
  relationId: string;
  fromStatus: string;
  toStatus: string;
  changedById: string;
  reasonCode?: string | null;
  reasonNote?: string | null;
  /** Only for a backdated history correction; omitted rows use the DB default. */
  createdAt?: Date;
}

export interface StatusChangeData {
  relationId: string;
  fromStatus: string;
  toStatus: string;
  changedById: string;
  reasonCode: string | null;
  reasonNote: string | null;
  createdAt?: Date;
}

/**
 * The `data` for `prisma.statusChange.create()`, or `null` when the row would
 * be a no-op and must not be written at all.
 *
 * Returning the payload rather than performing the write keeps this usable from
 * inside the `$transaction([...])` arrays the write paths use, so the audit row
 * and the relation's `pipelineStatus` still land together or not at all.
 */
export function statusChangeData(input: StatusChangeInput): StatusChangeData | null {
  if (!isStageTransition(input.fromStatus, input.toStatus)) return null;
  return {
    relationId: input.relationId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    changedById: input.changedById,
    reasonCode: input.reasonCode ?? null,
    reasonNote: input.reasonNote?.trim() || null,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  };
}
