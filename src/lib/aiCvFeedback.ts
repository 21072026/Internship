// AI CV improvement feedback for mentees (Faz 2, #535). Sends only the
// already-extracted CV TEXT (same rule as cvExtractAi) and returns
// constructive, structured suggestions. Callers MUST go through runAiGated
// (consent + quota); this module only talks to the provider.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_CV_MODEL || 'claude-opus-4-8';
const MAX_INPUT_CHARS = 24_000;

const SYSTEM = `You review a student/junior CV and give constructive improvement feedback, written directly to the CV owner in the same language the CV is written in. Return three short sections with these exact markdown headers: "**Strengths**", "**Improvements**", "**Missing**". Under each, 2-5 concise bullet points grounded in the actual CV content (never invent experience). Improvements should be specific and actionable (wording, structure, quantification); Missing lists sections or details worth adding. Keep the whole answer under 250 words.`;

export async function aiCvFeedback(text: string): Promise<string> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: SYSTEM,
    messages: [{ role: 'user', content: `CV text:\n\n${text.slice(0, MAX_INPUT_CHARS)}` }],
  });
  const block = res.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text.trim() : '';
}
