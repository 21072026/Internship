// AI CV improvement feedback for mentees (Faz 2, #535). Sends only the
// already-extracted CV TEXT (same rule as cvExtractAi) and returns
// constructive, structured suggestions. Callers MUST go through runAiGated
// (consent + quota); this module holds the prompt only — the client, model,
// timeout and input cap are callModel's (#2022, task `cv_feedback`).

import { callModel } from '@/lib/ai/provider';

const SYSTEM = `You review a student/junior CV and give constructive improvement feedback, written directly to the CV owner in the same language the CV is written in. Return three short sections with these exact markdown headers: "**Strengths**", "**Improvements**", "**Missing**". Under each, 2-5 concise bullet points grounded in the actual CV content (never invent experience). Improvements should be specific and actionable (wording, structure, quantification); Missing lists sections or details worth adding. Keep the whole answer under 250 words.`;

export async function aiCvFeedback(text: string): Promise<string> {
  return (await callModel({ task: 'cv_feedback', system: SYSTEM, input: `CV text:\n\n${text}` })).trim();
}
