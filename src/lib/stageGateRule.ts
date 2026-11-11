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

/**
 * The capabilities the stage editor offers (#1590). Anything else already on a
 * row is kept and shown by name; the PUT accepts any known Permission.
 */
export const GATE_CAPABILITY_CHOICES = ['pipeline.transition'] as const;

export interface EditableStage {
  key: string;
  label: string;
  order: number;
  isTerminal?: boolean;
  isOffPath?: boolean;
  color?: string | null;
  phase?: string | null;
}

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase() || null;

/**
 * True when `next` changes nothing but the entry gates of `current` (#1590):
 * the same keys in the same order, labels, flags, colours and phases. This is
 * what a FREE tenant may save — gates are a compliance control and never
 * paywalled; only the stage set's look and shape is a paid customisation.
 * `isDefault(key, label)` says whether a label is just the built-in one in some
 * language, so a FREE editor that echoes the localized default still matches.
 */
export function onlyGatesChanged(
  current: readonly EditableStage[],
  next: readonly EditableStage[],
  isDefault: (key: string, label: string) => boolean,
  isPhase: (value: unknown) => boolean,
): boolean {
  if (current.length !== next.length) return false;
  const a = [...current].sort((x, y) => x.order - y.order);
  const b = [...next].sort((x, y) => x.order - y.order);
  return a.every((c, i) => {
    const n = b[i];
    if (c.key !== n.key) return false;
    const sameLabel = c.label.trim() === n.label.trim() || (isDefault(c.key, c.label) && isDefault(n.key, n.label));
    const phase = (p: string | null | undefined) => (isPhase(p) ? p : null);
    return (
      sameLabel &&
      !!c.isTerminal === !!n.isTerminal &&
      !!c.isOffPath === !!n.isOffPath &&
      norm(c.color) === norm(n.color) &&
      phase(c.phase) === phase(n.phase)
    );
  });
}
