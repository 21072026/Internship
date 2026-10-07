// AI interview-prep assistant for mentees (Faz 2, #536). Generates tailored
// example questions + preparation tips from the target position and skills.
// Privacy by design: only the position/skills strings are sent — no name, no
// contact data, no CV. Callers MUST go through runAiGated (quota). The prompt
// is here; the client, model and timeout are callModel's (#2022, task
// `interview_prep`).

import { callModel } from '@/lib/ai/provider';

const SYSTEM = `You are an interview preparation coach for a student/junior candidate. Given a target position and skills, produce, in the same language as the input: (1) "**Questions**" — 6-8 realistic interview questions for that position (mix of technical and behavioral, ordered easy→hard); (2) "**Tips**" — 3-5 short, concrete preparation tips specific to the position and skills. Keep the whole answer under 350 words. Do not invent facts about the candidate.`;

export async function aiInterviewPrep(targetPosition: string, skills: string[], focus?: string): Promise<string> {
  const reply = await callModel({
    task: 'interview_prep',
    system: SYSTEM,
    input: `Target position: ${targetPosition}\nSkills: ${skills.join(', ') || '—'}${focus ? `\nSpecial focus: ${focus.slice(0, 300)}` : ''}`,
  });
  return reply.trim();
}
