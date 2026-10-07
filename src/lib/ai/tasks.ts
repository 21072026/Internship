// The AI task registry (#2022) — the one list of what this product asks a
// language model to do. Dependency-free and client-safe on purpose: a route,
// a component, a script and a unit test can all read it.
//
// WHY A REGISTRY
//   `runAiGated` used to take a free-string `scope`, so a typo silently opened
//   a new metering bucket; each feature module constructed its own SDK client
//   and read its own model env var; and nothing in the repo could answer "which
//   tasks exist, who are they for, what do they cost". Every entry here is the
//   contract one task has with the gate (src/lib/aiGate.ts), the provider
//   module (src/lib/ai/provider.ts) and the meter (`AiUsage`):
//     • `id` — the key. It IS the historic `AiUsage.scope` / `AiArtifact.taskId`
//       string, so metering history keeps its meaning. Never rename one.
//     • `audience` — who the output is for. `participant` AI is never paywalled
//       (CLAUDE.md, docs/ai.md § The two boundaries); #1738 makes the gate read
//       this field for the AI_PACKAGE entitlement on the operator side.
//     • `consent` — the ConsentType the subject must have granted, or null when
//       no personal identifier is in the payload (docs/ai.md § The task table
//       says why that is not a loophole).
//     • `tier` — the default model class. `resolveModel()` turns it into a model
//       id: AI_MODEL_<TASK_ID> → AI_MODEL_TIER_<TIER> → the task's legacy env var
//       → ANTHROPIC_CV_MODEL → the global default. Out of the box every tier
//       resolves to the same default model, so adding this field changed nothing;
//       an operator routes summaries to a cheaper model by setting one variable.
//     • `maxInputChars` / `maxOutputTokens` — applied centrally by `callModel()`.
//       The 24 000-char cap is the one every text task carried before; it is
//       here so it cannot be weakened one module at a time.
//
// ADDING A TASK: one entry here, a `src/lib/ai<Task>.ts` module that calls
// `callModel({ task: '<id>', … })`, and the row in docs/ai.md. A task missing
// here does not compile at the gate.

import type { ConsentType } from '@prisma/client';

export type AiAudience = 'participant' | 'operator';
export type AiModelTier = 'fast' | 'balanced' | 'strong';

export interface AiTaskSpec {
  /** Short human label for consoles and reports. */
  label: string;
  audience: AiAudience;
  consent: ConsentType | null;
  tier: AiModelTier;
  /** Longest user message `callModel()` sends; anything past it is cut. */
  maxInputChars: number;
  /** `max_tokens` of the reply unless the call lowers it. */
  maxOutputTokens: number;
  /**
   * An env var an operator may already have set for this task before per-task
   * routing existed. Read after the per-task and per-tier overrides so an
   * existing deployment keeps its model; new tasks leave it out.
   */
  legacyModelEnv?: 'ANTHROPIC_SUMMARY_MODEL';
  /**
   * The task genuinely needs contact details from the user text (#2026). Left
   * out — the default — `callModel()` masks e-mail addresses, phone numbers,
   * links, IBANs, ID numbers and street addresses in the untrusted blocks
   * before they leave (src/lib/ai/redact.ts).
   */
  needsContactDetails?: true;
}

/** The default cap on text sent in one call — bounded regardless of CV or log size. */
export const DEFAULT_MAX_INPUT_CHARS = 24_000;

export const AI_TASKS = {
  // CV text → structured profile suggestions (EPIC B3). The mentee applies them
  // field by field; the file itself never leaves.
  cv_extract: { label: 'CV field extraction', audience: 'participant', consent: 'AI_CV_PARSING', tier: 'balanced', maxInputChars: DEFAULT_MAX_INPUT_CHARS, maxOutputTokens: 1024, needsContactDetails: true },
  // Constructive feedback on the mentee's own CV text (#535).
  cv_feedback: { label: 'CV feedback', audience: 'participant', consent: 'AI_CV_PARSING', tier: 'balanced', maxInputChars: DEFAULT_MAX_INPUT_CHARS, maxOutputTokens: 700 },
  // A mentor-facing digest of one relation's interaction log (#534); the
  // mentee whose log it is consents.
  interaction_summary: { label: 'Interaction summary', audience: 'operator', consent: 'AI_INTERACTION_SUMMARY', tier: 'fast', maxInputChars: DEFAULT_MAX_INPUT_CHARS, maxOutputTokens: 700, legacyModelEnv: 'ANTHROPIC_SUMMARY_MODEL' },
  // Interview questions and tips from the target position and skills (#536):
  // no identifier is sent, so no consent type.
  interview_prep: { label: 'Interview preparation', audience: 'participant', consent: null, tier: 'balanced', maxInputChars: DEFAULT_MAX_INPUT_CHARS, maxOutputTokens: 900 },
  // Re-ranking of anonymous mentor labels for one mentee (#533). The payload is
  // JSON, which must never be cut mid-structure: the field limits bound it well
  // under this cap (five candidates × capped skills and interests), so the cap
  // is a backstop, not a budget.
  mentor_match: { label: 'Mentor match ranking', audience: 'operator', consent: null, tier: 'strong', maxInputChars: 32_000, maxOutputTokens: 600 },
  // The three open-text engines (#2046, #1910): many masked rows in, verified
  // themes out. They share one prompt in src/lib/ai/summarizeOpenText.ts. The
  // rows are bounded upstream by `prepareOpenText` (MAX_SUMMARY_INPUT_CHARS of
  // text, whole rows only); the cap here sits above that so it can never cut a
  // row in half — a half row would fail the verbatim quote check.
  survey_summary: { label: 'Survey answer themes', audience: 'operator', consent: null, tier: 'balanced', maxInputChars: 32_000, maxOutputTokens: 1500, legacyModelEnv: 'ANTHROPIC_SUMMARY_MODEL' },
  evaluation_insights: { label: 'Evaluation comment themes', audience: 'operator', consent: null, tier: 'balanced', maxInputChars: 32_000, maxOutputTokens: 1500, legacyModelEnv: 'ANTHROPIC_SUMMARY_MODEL' },
  weekly_report_digest: { label: 'Weekly report blockers digest', audience: 'operator', consent: null, tier: 'balanced', maxInputChars: 32_000, maxOutputTokens: 1500, legacyModelEnv: 'ANTHROPIC_SUMMARY_MODEL' },
  // The "what changed" paragraph on /admin/analytics (#2046): totals only.
  analytics_narrative: { label: 'Analytics narrative', audience: 'operator', consent: null, tier: 'fast', maxInputChars: DEFAULT_MAX_INPUT_CHARS, maxOutputTokens: 500, legacyModelEnv: 'ANTHROPIC_SUMMARY_MODEL' },
  // Conversation catch-up and suggested replies (#2048). Participant-facing
  // and free; the consent is checked for everyone quoted (threadAiContext.ts),
  // and the transcript is already cut to 16k by threadAiRules.buildTranscript.
  thread_summary: { label: 'Conversation catch-up', audience: 'participant', consent: 'AI_INTERACTION_SUMMARY', tier: 'fast', maxInputChars: DEFAULT_MAX_INPUT_CHARS, maxOutputTokens: 600 },
  suggested_reply: { label: 'Suggested reply', audience: 'participant', consent: 'AI_INTERACTION_SUMMARY', tier: 'fast', maxInputChars: DEFAULT_MAX_INPUT_CHARS, maxOutputTokens: 400 },
  // Grounded outreach drafts (#2048, part 2): a draft for the mentor to edit,
  // never sent by any code path. The relation's facts are the mentee's data.
  outreach_draft: { label: 'Outreach draft', audience: 'participant', consent: 'AI_INTERACTION_SUMMARY', tier: 'fast', maxInputChars: DEFAULT_MAX_INPUT_CHARS, maxOutputTokens: 600 },
  // One draft for a bulk e-mail, personalised by {name}: the sender's own
  // purpose text is all it reads, so no one's consent is involved.
  bulk_draft: { label: 'Bulk e-mail draft', audience: 'participant', consent: null, tier: 'fast', maxInputChars: DEFAULT_MAX_INPUT_CHARS, maxOutputTokens: 700 },
} as const satisfies Record<string, AiTaskSpec>;

export type AiTaskId = keyof typeof AI_TASKS;

export const AI_TASK_IDS = Object.keys(AI_TASKS) as AiTaskId[];

export function isAiTaskId(value: unknown): value is AiTaskId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AI_TASKS, value);
}

export function aiTask(id: AiTaskId): AiTaskSpec {
  return AI_TASKS[id];
}
