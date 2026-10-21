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

import { prisma } from './prisma';
import { resolvePipelineStages } from './pipelineStages';
import { isDropoffReasonCodeFor } from './dropoffReasons';
import { isAttributionStage, isEmploymentAttribution } from './placementKind';
import { verticalFor } from './verticalContext';

// The no-regression rule for MACHINE writers (#2451): pure, so it is unit-tested
// on its own — see the module's header.
export { isBackwardMove, type StageForDirection } from './stageDirection';

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
  // The ORG's vertical decides the list (#2573): a MARKETING loss is not a
  // hiring drop-off, and the other product's codes are refused, not mapped.
  const vertical = input.orgId ? await verticalFor(input.orgId) : null;
  if (!isDropoffReasonCodeFor(vertical, input.reasonCode)) {
    return { ok: false, error: 'Unknown reasonCode' };
  }
  if (input.reasonCode === 'OTHER' && !input.reasonNote?.trim()) {
    return { ok: false, error: 'reasonNote is required when reasonCode is OTHER' };
  }
  return { ok: true };
}

// ── Employment attribution (#1503) ──────────────────────────────────────────
//
// A move into the org's hire stage is where "whose outcome is this?" belongs
// (THROUGH_US | SELF_FOUND | ALREADY_EMPLOYED, src/lib/placementKind.ts). The
// rule lives here, next to the drop-off reason, so every stage write path can
// call the same function.
//
// NOT ENFORCED YET, on purpose: no screen sends an attribution today (the
// board, the stage select, the candidate detail, the offer auto-advance), so a
// 400 for a missing one would break every hire. Until the UI that asks for it
// ships, a missing attribution on a hire stage is allowed and stays NULL (read
// as THROUGH_US); a value that IS sent must be on the whitelist. The UI change
// flips EMPLOYMENT_ATTRIBUTION_REQUIRED in the same PR.
export const EMPLOYMENT_ATTRIBUTION_REQUIRED = false;

export interface EmploymentAttributionInput {
  orgId: string | null | undefined;
  toStatus: string;
  attribution?: string | null;
}

export type EmploymentAttributionValidation =
  | { ok: true; /** Is the target a hire stage (so a sent attribution is stored)? */ hireStage: boolean }
  | { ok: false; error: string };

export async function validateEmploymentAttribution(
  input: EmploymentAttributionInput,
): Promise<EmploymentAttributionValidation> {
  if (input.attribution != null && !isEmploymentAttribution(input.attribution)) {
    return { ok: false, error: 'Unknown employmentAttribution' };
  }
  // A sale is not a hire: the MARKETING funnel's last stage carries no attribution.
  const vertical = input.orgId ? await verticalFor(input.orgId) : null;
  if (vertical === 'MARKETING') return { ok: true, hireStage: false };
  const hireStage = isAttributionStage(await resolvePipelineStages(input.orgId), input.toStatus);
  if (hireStage && EMPLOYMENT_ATTRIBUTION_REQUIRED && !input.attribution) {
    return { ok: false, error: 'employmentAttribution is required when moving into a hire stage' };
  }
  return { ok: true, hireStage };
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
  /** `null` for a move the system made on its own (#2527) — never a stand-in person. */
  changedById: string | null;
  reasonCode?: string | null;
  reasonNote?: string | null;
  /** Only for a backdated history correction; omitted rows use the DB default. */
  createdAt?: Date;
}

export interface StatusChangeData {
  relationId: string;
  fromStatus: string;
  toStatus: string;
  changedById: string | null;
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

// ── The read side of the same rule (#2264) ──────────────────────────────────
//
// The gate above stops NEW no-op rows; the ones already in the table stay, and
// they are still arithmetic for anything that reads them. A reader that wants
// only real moves filters with this rather than fetching the noise and
// discarding it in JS — which matters most for the stage clock, whose queries
// are `orderBy createdAt desc, take: 1`: the newest row is the answer, so
// filtering afterwards cannot recover the move the no-op hid.
//
// It is a field-to-field comparison (`fromStatus <> toStatus`), which Prisma
// expresses as a reference rather than a value, and only under `equals` —
// `not: <ref>` is rejected at runtime, hence the `NOT` wrapper.
//
// `src/lib/stageClock.ts` applies the same rule in memory for the callers that
// already hold the full history (the mentee detail page, the aging report);
// this is the same rule where the query can enforce it.
export const REAL_STAGE_MOVE = {
  NOT: { fromStatus: { equals: prisma.statusChange.fields.toStatus } },
} as const;
