// Per-model list prices (#2022), so an `AiUsage` row can carry what a call
// cost. Dependency-free; unit-tested in scripts/test/ai-tasks.test.mjs.
//
// SOURCE: Anthropic's published first-party API rates (platform.claude.com
// → pricing), as read on 2026-09-25. In US dollars per million tokens, which is
// the currency the provider bills in — a euro figure here would need an
// exchange rate nobody maintains. `costMicros` on `AiUsage` is therefore
// MICRO-DOLLARS: tokens × $/Mtok is exactly micro-dollars, so no rounding
// happens before the sum. Prompt-cache reads and writes are not priced because
// no task uses caching; add the two rates the day one does.
//
// A model not in this table costs `null`, never a guess: an estimate that is
// silently wrong is worse than a blank the console can show as "unknown".
// Update the table when a price changes or a model lands, with the date.

export interface ModelRate {
  /** USD per million input tokens. */
  inputUsdPerMtok: number;
  /** USD per million output tokens. */
  outputUsdPerMtok: number;
}

/**
 * Keyed on the model id WITHOUT a date suffix: `claude-haiku-4-5-20251001`
 * resolves to the `claude-haiku-4-5` row (longest matching family wins, so
 * `claude-opus-5-5` is not read as `claude-opus-5`).
 */
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  'claude-fable-5-1': { inputUsdPerMtok: 10, outputUsdPerMtok: 50 },
  'claude-fable-5': { inputUsdPerMtok: 10, outputUsdPerMtok: 50 },
  'claude-opus-5-5': { inputUsdPerMtok: 4, outputUsdPerMtok: 20 },
  'claude-opus-5': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
  'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
  'claude-opus-4-7': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
  'claude-opus-4-6': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
  'claude-sonnet-5-5': { inputUsdPerMtok: 2, outputUsdPerMtok: 10 },
  'claude-sonnet-5': { inputUsdPerMtok: 2, outputUsdPerMtok: 10 },
  'claude-sonnet-4-6': { inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
  'claude-haiku-4-5': { inputUsdPerMtok: 1, outputUsdPerMtok: 5 },
};

const FAMILIES = Object.keys(MODEL_RATES).sort((a, b) => b.length - a.length);

/** The rate row for a model id, or null when it is not in the table. */
export function rateFor(model: string | null | undefined): ModelRate | null {
  if (!model) return null;
  const family = FAMILIES.find((f) => model === f || model.startsWith(`${f}-`));
  return family ? MODEL_RATES[family] : null;
}

/**
 * The list price of a call in micro-dollars, or null when the model is not
 * priced. Integer, so it fits the `Int` column and sums without float drift.
 */
export function estimateCostMicros(model: string | null | undefined, inputTokens: number, outputTokens: number): number | null {
  const rate = rateFor(model);
  if (!rate) return null;
  return Math.round(inputTokens * rate.inputUsdPerMtok + outputTokens * rate.outputUsdPerMtok);
}
