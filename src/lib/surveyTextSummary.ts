// The provider call behind "summarise these answers" (#1910). Callers MUST go
// through runAiGated (quota + metering) and must send only what
// prepareAnswerTexts (src/lib/surveyTextRules.ts) returns; the reply goes back
// through parseSummary, which drops any quote no answer contains.

import Anthropic from '@anthropic-ai/sdk';
import { parseSummary, type SummaryTheme } from '@/lib/surveyTextRules';

const AI_TIMEOUT_MS = 60_000;
const MODEL = process.env.ANTHROPIC_SUMMARY_MODEL || process.env.ANTHROPIC_CV_MODEL || 'claude-opus-4-8';

// The rules the issue sets, in the model's words: the answers' own language,
// nothing they do not say, nobody named.
const SYSTEM = `You summarise the written answers to one survey question for the programme team that ran the survey.
Return ONLY JSON of the form {"themes":[{"theme":"short theme title","quotes":["exact quote", "..."]}]} with 2-6 themes, most frequent first.
Rules:
- Write the theme titles in the language most answers are written in.
- Every quote must be copied exactly, character for character, from one of the answers. Do not paraphrase inside a quote. At most three quotes per theme, each a short sentence or phrase.
- Never name or identify a person: no names, no roles that single someone out, no guesses about who wrote what. Leave out any quote that names a person.
- Say nothing the answers do not contain. Do not add advice or conclusions of your own.`;

export async function aiSummarizeSurveyTexts(question: string, answers: string[]): Promise<SummaryTheme[] | null> {
  const client = new Anthropic({ timeout: AI_TIMEOUT_MS, maxRetries: 0 }); // retries are runAiGated's (src/lib/ai/provider.ts, #2024)
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: SYSTEM,
    messages: [{ role: 'user', content: `Question: ${question}\n\nAnswers (one per block, unattributed):\n\n${answers.join('\n---\n')}` }],
  });
  const block = res.content.find((b) => b.type === 'text');
  return parseSummary(block && block.type === 'text' ? block.text : '', answers);
}
