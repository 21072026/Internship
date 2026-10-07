// AI auto-summary of a mentorship's interaction logs (Faz 2, #534). Sends only
// the log text (dates, types, subjects, notes) — never files or contact data —
// and returns a compact mentor-facing summary. Callers MUST go through
// runAiGated (consent + quota); this module holds the prompt only — the
// client, model, timeout and input cap are callModel's (#2022, task
// `interaction_summary`).

import { callModel } from '@/lib/ai/provider';

export interface SummaryInteraction {
  date: Date;
  type: string;
  subject?: string | null;
  notes: string;
}

const SYSTEM = `You summarize a mentor's interaction log with one mentee. Write for the mentor. Use the same language the log entries are written in. Return 4-8 short bullet lines covering: overall progress, recurring themes, open risks or blockers, and 1-2 concrete suggested next steps. Be specific to the log content; do not invent facts.`;

export async function aiSummarizeInteractions(menteeName: string, interactions: SummaryInteraction[]): Promise<string> {
  const log = interactions
    .map((i) => `${i.date.toISOString().slice(0, 10)} · ${i.type}${i.subject ? ` · ${i.subject}` : ''}\n${i.notes}`)
    .join('\n---\n');
  const reply = await callModel({
    task: 'interaction_summary',
    system: SYSTEM,
    input: `Mentee: ${menteeName}\n\nInteraction log (newest first):\n\n${log}`,
  });
  return reply.trim();
}
