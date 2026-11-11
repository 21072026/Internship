// The profile digest call (#2038). Server-only; the client, model and caps are
// callModel's (task `profile_digest`). Callers MUST go through runAiGated — the
// one caller is refreshProfileDigest() in src/lib/profileDigest.ts.
//
// In: the person's own labelled free text, fenced as untrusted data (#2026).
// Out: a short neutral paragraph and up to 12 ENGLISH theme tokens, which the
// semantic match rule compares without ever calling a model again.

import { z } from 'zod';
import { callModel, safeParseModelJson, type ModelCreate } from '@/lib/ai/provider';
import { wrapUntrusted } from '@/lib/ai/untrusted';
import { DIGEST_MAX_THEMES, readDigestReply } from '@/lib/profileDigestRule';

const REPLY = z.object({ digest: z.string(), themes: z.array(z.string()) }).partial();

export async function generateProfileDigest(sourceText: string, create?: ModelCreate): Promise<{ digest: string; themes: string[] } | null> {
  const reply = await callModel(
    {
      task: 'profile_digest',
      system:
        'You summarise one person’s profile on a mentoring and internship platform so it can be compared with other profiles. ' +
        '"digest": 2-3 neutral sentences in English on what the person does, wants and can help with — no name, no praise, nothing the text does not say. ' +
        `"themes": up to ${DIGEST_MAX_THEMES} short ENGLISH noun phrases (1-3 words, lower case) for the fields, roles, technologies, industries and career goals the text is about — ` +
        'translate them to English whatever language the text is in, prefer common names ("backend engineering", "career switch", "go"), never a person, company or place name. ' +
        'Use only what the text says. Return ONLY JSON {"digest": "...", "themes": ["..."]}.',
      input: `Profile:\n${wrapUntrusted('profile', sourceText)}`,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { digest: { type: 'string' }, themes: { type: 'array', items: { type: 'string' } } },
        required: ['digest', 'themes'],
      },
    },
    create,
  );
  return readDigestReply(safeParseModelJson(reply, REPLY, {}));
}
