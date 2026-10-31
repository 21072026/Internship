// Stage entry gates (#1589, story #1588) — the pure half: which move is gated
// at all, and which of a stage's configured checks it must pass. No Prisma, no
// session; the server half that reads the evidence is src/lib/stageGate.ts.
//
// Three rules hold whatever a tenant configures:
//   · a stage with no configured gate is open — an org that sets nothing
//     behaves exactly as before the gates existed;
//   · a move BACKWARDS (to a stage ordered at or before the current one) or
//     into an off-path stage is never gated — a correction and a drop-out must
//     always be recordable, or the data stops reflecting reality;
//   · a capability that is not a known Permission refuses the move
//     (fail-closed): a typo in a rule must never read as "no rule".

import { isPermission, type Permission } from '@/lib/authzRule';

export const GATE_CODES = ['capability', 'documents', 'evaluation', 'offer'] as const;
export type GateCode = (typeof GATE_CODES)[number];

/** The machine-readable refusal (`409 { error: 'stage_gate_blocked', gate }`). */
export interface GateFailure {
  code: GateCode;
  /** The stage the move was refused into. */
  stage: string;
  /** What is missing, localized for the mover: documents, or the capability name. */
  missing?: { key: string; label: string }[];
}

export interface StageGateConfig {
  gateCapability: string | null;
  gateDocuments: boolean;
  gateEvaluation: boolean;
  gateOffer: boolean;
}

export interface GateStage extends Partial<StageGateConfig> {
  key: string;
  order: number;
  isOffPath: boolean;
}

export function hasGate(stage: Partial<StageGateConfig> | null | undefined): boolean {
  return !!stage && (!!stage.gateCapability || !!stage.gateDocuments || !!stage.gateEvaluation || !!stage.gateOffer);
}

/**
 * The target stage's row when this move must pass its gates, else null.
 * A current stage the tenant no longer has counts as "before everything", so
 * the move out of it is judged like any forward move.
 */
export function gatedTarget(stages: readonly GateStage[], from: string, to: string): GateStage | null {
  if (from === to) return null;
  const target = stages.find((s) => s.key === to);
  if (!target || target.isOffPath || !hasGate(target)) return null;
  const current = stages.find((s) => s.key === from);
  if (current && target.order <= current.order) return null;
  return target;
}

/** The configured capability, or `invalid` for a name that is not a Permission. */
export function gateCapability(stage: Partial<StageGateConfig>): Permission | 'invalid' | null {
  const raw = stage.gateCapability?.trim();
  if (!raw) return null;
  return isPermission(raw) ? raw : 'invalid';
}

/** The offer statuses that count as "an offer was made" for an offer gate. */
export const GATE_OFFER_STATUSES = ['SENT', 'ACCEPTED'] as const;
