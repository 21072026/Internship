// The AI task registry, model routing, pricing and the one-importer rule (#2022).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { AI_TASKS, AI_TASK_IDS, isAiTaskId, DEFAULT_MAX_INPUT_CHARS } = await import('../../src/lib/ai/tasks.ts');
const { MODEL_RATES, rateFor, estimateCostMicros } = await import('../../src/lib/ai/pricing.ts');
const { resolveModel, modelEnvVar, tierEnvVar, callModel, trackAiCall, usageOfFailure, DEFAULT_MODEL, AI_PROVIDER, isAiConfigured } =
  await import('../../src/lib/ai/provider.ts');

// ── The registry ─────────────────────────────────────────────────────────────

test('every historic scope string is a registry id, and every entry is complete', () => {
  // The ids are the AiUsage.scope / AiArtifact.taskId values already in the
  // database. Renaming one would orphan metering history.
  for (const id of ['cv_extract', 'cv_feedback', 'interaction_summary', 'interview_prep', 'mentor_match', 'survey_summary', 'evaluation_insights', 'weekly_report_digest', 'analytics_narrative']) {
    assert.ok(isAiTaskId(id), `${id} is registered`);
  }
  assert.equal(isAiTaskId('cv-extract'), false);
  assert.equal(isAiTaskId(''), false);
  assert.equal(isAiTaskId(null), false);
  for (const id of AI_TASK_IDS) {
    const spec = AI_TASKS[id];
    assert.match(id, /^[a-z_]+$/, `${id}: snake_case, so AI_MODEL_<ID> is a valid variable name`);
    assert.ok(spec.label.length > 0, `${id}: label`);
    assert.ok(['participant', 'operator'].includes(spec.audience), `${id}: audience`);
    assert.ok(['fast', 'balanced', 'strong'].includes(spec.tier), `${id}: tier`);
    assert.ok(spec.maxInputChars >= DEFAULT_MAX_INPUT_CHARS, `${id}: the input cap is never below the historic 24k`);
    assert.ok(spec.maxOutputTokens > 0 && spec.maxOutputTokens <= 2048, `${id}: output cap`);
  }
});

test('participant tasks that process personal data name a consent type', () => {
  assert.equal(AI_TASKS.cv_extract.consent, 'AI_CV_PARSING');
  assert.equal(AI_TASKS.cv_feedback.consent, 'AI_CV_PARSING');
  assert.equal(AI_TASKS.interaction_summary.consent, 'AI_INTERACTION_SUMMARY');
  // No identifier in the payload (docs/ai.md § The task table).
  assert.equal(AI_TASKS.interview_prep.consent, null);
  assert.equal(AI_TASKS.mentor_match.consent, null);
});

// ── Model routing ────────────────────────────────────────────────────────────

test('resolveModel: per-task env, then tier env, then the legacy variable, then the global override, then the default', () => {
  assert.equal(modelEnvVar('cv_extract'), 'AI_MODEL_CV_EXTRACT');
  assert.equal(tierEnvVar('fast'), 'AI_MODEL_TIER_FAST');

  assert.equal(resolveModel('cv_extract', {}), DEFAULT_MODEL);
  assert.equal(resolveModel('cv_extract', { ANTHROPIC_CV_MODEL: 'cv-global' }), 'cv-global');
  // The summary family kept ANTHROPIC_SUMMARY_MODEL; CV tasks never read it.
  assert.equal(resolveModel('interaction_summary', { ANTHROPIC_CV_MODEL: 'cv-global', ANTHROPIC_SUMMARY_MODEL: 'summary' }), 'summary');
  assert.equal(resolveModel('cv_extract', { ANTHROPIC_CV_MODEL: 'cv-global', ANTHROPIC_SUMMARY_MODEL: 'summary' }), 'cv-global');
  // A tier routes every task in it, above the legacy variables.
  const tiered = { ANTHROPIC_SUMMARY_MODEL: 'summary', AI_MODEL_TIER_FAST: 'fast-model', AI_MODEL_TIER_STRONG: 'strong-model' };
  assert.equal(resolveModel('interaction_summary', tiered), 'fast-model');
  assert.equal(resolveModel('mentor_match', tiered), 'strong-model');
  assert.equal(resolveModel('cv_feedback', tiered), DEFAULT_MODEL); // balanced: no tier var set
  // A per-task variable wins over everything.
  assert.equal(resolveModel('interaction_summary', { ...tiered, AI_MODEL_INTERACTION_SUMMARY: 'exact' }), 'exact');
  // An empty variable is unset, not a model named ''.
  assert.equal(resolveModel('cv_extract', { AI_MODEL_CV_EXTRACT: '', ANTHROPIC_CV_MODEL: '' }), DEFAULT_MODEL);
});

test('every tier resolves to the same default out of the box (no behaviour change from #2022)', () => {
  for (const id of AI_TASK_IDS) assert.equal(resolveModel(id, {}), DEFAULT_MODEL);
});

test('isAiConfigured reads the key at call time', () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(isAiConfigured(), false);
    process.env.ANTHROPIC_API_KEY = 'k';
    assert.equal(isAiConfigured(), true);
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

// ── Pricing ──────────────────────────────────────────────────────────────────

test('pricing: the default model is priced, a dated id resolves to its family, the longest family wins, unknown is null', () => {
  assert.ok(rateFor(DEFAULT_MODEL), 'the default model must be in the rate table');
  assert.deepEqual(rateFor('claude-haiku-4-5-20251001'), MODEL_RATES['claude-haiku-4-5']);
  assert.deepEqual(rateFor('claude-opus-5-5'), MODEL_RATES['claude-opus-5-5']);
  assert.notDeepEqual(rateFor('claude-opus-5-5'), MODEL_RATES['claude-opus-5']);
  assert.equal(rateFor('claude-opus-55'), null); // a prefix without the family boundary is not a match
  assert.equal(rateFor('gpt-x'), null);
  assert.equal(rateFor(null), null);
  // tokens × $/Mtok is micro-dollars: 10 000 in + 1 000 out on Opus 4.8 ($5 / $25) = $0.075.
  assert.equal(estimateCostMicros('claude-opus-4-8', 10_000, 1_000), 75_000);
  assert.equal(estimateCostMicros('unknown-model', 10_000, 1_000), null);
  assert.equal(estimateCostMicros('claude-opus-4-8', 0, 0), 0);
});

// ── callModel ────────────────────────────────────────────────────────────────

const reply = (text, usage = { input_tokens: 120, output_tokens: 30 }, model = 'claude-opus-4-8') => ({
  model,
  content: [{ type: 'text', text }],
  usage,
});

test('callModel sends the task registry entry and records what the provider answered with', async () => {
  const seen = [];
  const create = async (params) => {
    seen.push(params);
    return reply('hello');
  };
  const { result, parseError, usage } = await trackAiCall(() =>
    callModel({ task: 'cv_feedback', system: 'SYS', input: 'CV text', jsonSchema: { type: 'object' } }, create),
  );
  assert.equal(result, 'hello');
  assert.equal(parseError, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, resolveModel('cv_feedback'));
  assert.equal(seen[0].max_tokens, AI_TASKS.cv_feedback.maxOutputTokens);
  assert.equal(seen[0].system, 'SYS');
  assert.deepEqual(seen[0].messages, [{ role: 'user', content: 'CV text' }]);
  assert.deepEqual(seen[0].output_config, { format: { type: 'json_schema', schema: { type: 'object' } } });
  assert.equal(usage.provider, AI_PROVIDER);
  assert.equal(usage.model, 'claude-opus-4-8');
  assert.equal(usage.inputTokens, 120);
  assert.equal(usage.outputTokens, 30);
  assert.equal(usage.completed, 1);
  assert.ok(usage.latencyMs >= 0);
});

test('callModel applies the task input cap centrally and never raises the output cap', async () => {
  let params;
  const create = async (p) => {
    params = p;
    return reply('x');
  };
  const long = 'a'.repeat(AI_TASKS.cv_extract.maxInputChars + 500);
  await callModel({ task: 'cv_extract', system: 'S', input: long, maxTokens: 999_999 }, create);
  assert.equal(params.messages[0].content.length, AI_TASKS.cv_extract.maxInputChars);
  assert.equal(params.max_tokens, AI_TASKS.cv_extract.maxOutputTokens);
  assert.equal('output_config' in params, false, 'no schema → no output_config');
  await callModel({ task: 'cv_extract', system: 'S', input: 'short', maxTokens: 10 }, create);
  assert.equal(params.max_tokens, 10);
});

test('a reply with no text block is an empty string, and tokens add up across the calls of one task', async () => {
  let n = 0;
  const create = async () => (n++ === 0 ? reply('first', { input_tokens: 10, output_tokens: 1 }) : { model: 'm', content: [], usage: { input_tokens: 5, output_tokens: 0 } });
  const { result, usage } = await trackAiCall(async () => {
    const a = await callModel({ task: 'interview_prep', system: 'S', input: 'i' }, create);
    const b = await callModel({ task: 'interview_prep', system: 'S', input: 'i' }, create);
    return [a, b];
  });
  assert.deepEqual(result, ['first', '']);
  assert.equal(usage.inputTokens, 15);
  assert.equal(usage.outputTokens, 1);
  assert.equal(usage.completed, 2);
  assert.equal(usage.model, 'm');
});

test('a failed call still says which model was asked, with no token counts', async () => {
  const create = async () => {
    throw Object.assign(new Error('boom'), { status: 503 });
  };
  await assert.rejects(
    trackAiCall(() => callModel({ task: 'mentor_match', system: 'S', input: '{}' }, create)),
    (error) => {
      const usage = usageOfFailure(error);
      assert.equal(usage.model, resolveModel('mentor_match'));
      assert.equal(usage.completed, 0);
      assert.equal(usage.inputTokens, 0);
      return true;
    },
  );
  assert.equal(usageOfFailure(new Error('plain')), null);
});

test('outside a tracked call, callModel still answers and records nothing', async () => {
  const create = async () => reply('ok');
  assert.equal(await callModel({ task: 'cv_feedback', system: 'S', input: 'i' }, create), 'ok');
});

// ── The one-importer rule ────────────────────────────────────────────────────

test('src/lib/ai/provider.ts is the only file under src/ that imports @anthropic-ai/sdk', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../src');
  const hits = [];
  // Dirent types from the one readdir, not a stat-then-read (CodeQL js/file-system-race).
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && readFileSync(full, 'utf8').includes('@anthropic-ai/sdk')) hits.push(path.relative(root, full));
    }
  };
  walk(root);
  assert.deepEqual(hits, ['lib/ai/provider.ts']);
});
