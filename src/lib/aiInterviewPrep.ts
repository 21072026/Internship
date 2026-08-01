// AI interview-prep assistant for mentees (Faz 2, #536). Generates tailored
// example questions + preparation tips from the target position and skills.
// Privacy by design: only the position/skills strings are sent — no name, no
// contact data, no CV. Callers MUST go through runAiGated (quota).

import Anthropic from '@anthropic-ai/sdk';

// A generation that has not answered in a minute is not going to.
const AI_TIMEOUT_MS = 60_000;

const MODEL = process.env.ANTHROPIC_CV_MODEL || 'claude-opus-4-8';

const SYSTEM = `You are an interview preparation coach for a student/junior candidate. Given a target position and skills, produce, in the same language as the input: (1) "**Questions**" — 6-8 realistic interview questions for that position (mix of technical and behavioral, ordered easy→hard); (2) "**Tips**" — 3-5 short, concrete preparation tips specific to the position and skills. Keep the whole answer under 350 words. Do not invent facts about the candidate.`;

export async function aiInterviewPrep(targetPosition: string, skills: string[], focus?: string): Promise<string> {
  // reads ANTHROPIC_API_KEY. The SDK's own default timeout is 10 minutes, long
  // enough to hold a request handler open until the user gives up (#895).
  // Generation genuinely takes tens of seconds, so 60s — not the 5s webhooks get.
  const client = new Anthropic({ timeout: AI_TIMEOUT_MS });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 900,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Target position: ${targetPosition}\nSkills: ${skills.join(', ') || '—'}${focus ? `\nSpecial focus: ${focus.slice(0, 300)}` : ''}`,
    }],
  });
  const block = res.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text.trim() : '';
}
