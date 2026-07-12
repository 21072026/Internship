// AI auto-summary of a mentorship's interaction logs (Faz 2, #534). Sends only
// the log text (dates, types, subjects, notes) — never files or contact data —
// and returns a compact mentor-facing summary. Callers MUST go through
// runAiGated (consent + quota); this module only talks to the provider.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_SUMMARY_MODEL || process.env.ANTHROPIC_CV_MODEL || 'claude-opus-4-8';
const MAX_INPUT_CHARS = 24_000;

export interface SummaryInteraction {
  date: Date;
  type: string;
  subject?: string | null;
  notes: string;
}

const SYSTEM = `You summarize a mentor's interaction log with one mentee. Write for the mentor. Use the same language the log entries are written in. Return 4-8 short bullet lines covering: overall progress, recurring themes, open risks or blockers, and 1-2 concrete suggested next steps. Be specific to the log content; do not invent facts.`;

export async function aiSummarizeInteractions(menteeName: string, interactions: SummaryInteraction[]): Promise<string> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const log = interactions
    .map((i) => `${i.date.toISOString().slice(0, 10)} · ${i.type}${i.subject ? ` · ${i.subject}` : ''}\n${i.notes}`)
    .join('\n---\n')
    .slice(0, MAX_INPUT_CHARS);

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: SYSTEM,
    messages: [{ role: 'user', content: `Mentee: ${menteeName}\n\nInteraction log (newest first):\n\n${log}` }],
  });

  const block = res.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text.trim() : '';
}
