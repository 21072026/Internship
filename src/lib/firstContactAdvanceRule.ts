// First-contact auto-advance (#3746): the ONE decision, pure and dependency-free
// so the unit runner loads it (scripts/test/first-contact-advance-rule.test.mjs).
// The Prisma half is src/lib/firstContactAdvance.ts.
//
// WHAT IT IS — and what it deliberately is not. A sales rep logs "called them"
// on a brand-new lead; the lead should read "Contacted" without a second click.
// That is a NARROW, FIXED rule, not a stage-move action in the automation
// engine: docs/automation-rules.md keeps "never a stage move" for every
// admin-authored rule, and this one is not authored — it has one switch and one
// target, both org settings. The bounds are all here:
//   * MARKETING only (the sales vertical: `pipeline` without `mentorship`); any
//     other vertical reads the switch as off, whatever a row says;
//   * only the interaction types listed in FIRST_CONTACT_INTERACTION_TYPES count
//     — a note (Feedback) records something, it is not a contact;
//   * only a relation that is ACTIVE and still sits on the pipeline's FIRST
//     stage, and only FORWARD, to a target that is on the path after it — a lead
//     already further on, closed, paused or moved back by hand is never touched;
//   * no target in this pipeline → the rule does not run at all.

/** The stored switch. Blank and anything but 'on' read as off — a misspelt switch moves nothing. */
export const FIRST_CONTACT_MODES = ['off', 'on'] as const;
export type FirstContactMode = (typeof FIRST_CONTACT_MODES)[number];

/**
 * The interaction types that ARE a first contact. Listed, not derived: a new
 * InteractionType is not a contact until someone adds it here on purpose.
 * Feedback is a written note, not a contact. WhatsApp is left out because the
 * decision named call, meeting and e-mail (#3746); adding it is one entry.
 */
export const FIRST_CONTACT_INTERACTION_TYPES = ['Call', 'Meeting', 'Email'] as const;

/** The marketing preset's "Contacted" stage (src/lib/programTemplates.ts). */
export const DEFAULT_FIRST_CONTACT_TARGET = 'LEAD_CONTACTED';

export function parseFirstContactMode(value: unknown): FirstContactMode {
  return typeof value === 'string' && value.trim() === 'on' ? 'on' : 'off';
}

/** Can this vertical use the rule at all? The sales vertical only (same test as outbound approval). */
export function firstContactAdvanceApplies(caps: readonly string[]): boolean {
  return caps.includes('pipeline') && !caps.includes('mentorship');
}

export function isFirstContactType(type: string): boolean {
  return (FIRST_CONTACT_INTERACTION_TYPES as readonly string[]).includes(type);
}

export interface RuleStage {
  key: string;
  order: number;
  isTerminal: boolean;
  isOffPath: boolean;
}

/**
 * The target stage key, or null when there is none to move to: the stored key,
 * or the preset default when blank — and only if the pipeline has it, it is on
 * the path (not terminal, not off-path) and it comes after the start stage.
 */
export function resolveFirstContactTarget(stored: unknown, stages: readonly RuleStage[], startKey: string): string | null {
  const key = typeof stored === 'string' && stored.trim() ? stored.trim() : DEFAULT_FIRST_CONTACT_TARGET;
  const target = stages.find((s) => s.key === key);
  const start = stages.find((s) => s.key === startKey);
  if (!target || !start) return null;
  if (target.isTerminal || target.isOffPath) return null;
  if (target.order <= start.order) return null;
  return target.key;
}

export type FirstContactDecision =
  | { move: true; from: string; to: string }
  | {
      move: false;
      reason: 'vertical' | 'off' | 'type' | 'inactive' | 'no_target' | 'not_first_stage';
    };

/**
 * Whether logging `interactionType` on this relation moves it, and where.
 * `startKey` is the pipeline's first stage as src/lib/pipeline.ts's
 * startStageKey() reads it — the same first stage the dormant-first-contact
 * rule uses — passed in so this module stays dependency-free.
 */
export function decideFirstContactAdvance(input: {
  caps: readonly string[];
  mode: unknown;
  targetStage: unknown;
  interactionType: string;
  relationActive: boolean;
  currentStage: string;
  startKey: string;
  stages: readonly RuleStage[];
}): FirstContactDecision {
  if (!firstContactAdvanceApplies(input.caps)) return { move: false, reason: 'vertical' };
  if (parseFirstContactMode(input.mode) !== 'on') return { move: false, reason: 'off' };
  if (!isFirstContactType(input.interactionType)) return { move: false, reason: 'type' };
  if (!input.relationActive) return { move: false, reason: 'inactive' };
  const to = resolveFirstContactTarget(input.targetStage, input.stages, input.startKey);
  if (!to) return { move: false, reason: 'no_target' };
  if (input.currentStage !== input.startKey) return { move: false, reason: 'not_first_stage' };
  return { move: true, from: input.currentStage, to };
}
