// Machine translation of tenant-authored text (#2055): one source locale in,
// the requested target locales out, as the per-locale map every multilingual
// surface already stores (src/lib/machineTranslation.ts). Server-only; the
// client, model and caps are callModel's (task `content_translate`). Callers
// MUST go through runAiGated, and fold the result in with mergeMachine so a
// filled locale is never overwritten.

import { callModel, safeParseModelJson } from '@/lib/ai/provider';
import { wrapUntrusted } from '@/lib/ai/untrusted';
import { z } from 'zod';
import { locales, type Locale } from '@/i18n/config';
import type { LocaleMap, TranslationPurpose } from '@/lib/machineTranslation';

const LANGUAGE: Record<Locale, string> = { en: 'English', tr: 'Turkish', de: 'German' };

/** The tone each surface needs — the reader is a student, a mentor or a programme team member. */
const PURPOSE: Record<TranslationPurpose, string> = {
  announcement:
    'An announcement from a mentoring and internship programme to its participants. Keep it warm, direct and plain; keep line breaks, lists, dates, times, links and names exactly as they are.',
  goal_template:
    'A short goal a mentee works towards ("Update your CV with two measurable results"). Keep it an imperative, concise and concrete; never longer than the original.',
  message_template:
    'A reusable reply a mentor or coordinator inserts into a chat with a mentee. Keep the register of the original (informal stays informal), keep placeholders like {name} untouched.',
};

const REPLY = z.object({ translations: z.record(z.string(), z.string()) });

export async function translateContent(input: { text: string; from: Locale; to: Locale[]; purpose: TranslationPurpose }): Promise<LocaleMap> {
  const targets = input.to.filter((l) => l !== input.from && (locales as readonly string[]).includes(l));
  if (!targets.length || !input.text.trim()) return {};
  const reply = await callModel({
    task: 'content_translate',
    system:
      `You translate text written by a programme team so every reader gets it in their own language. ${PURPOSE[input.purpose]} ` +
      `Translate from ${LANGUAGE[input.from]} into: ${targets.map((l) => `${l} (${LANGUAGE[l]})`).join(', ')}. ` +
      'Translate meaning, not word by word; do not add, drop or explain anything. In German and Turkish address the reader with the informal form (du / sen) unless the original is clearly formal. ' +
      'Return ONLY JSON: {"translations": {"<locale>": "<text>"}} with exactly the requested locales.',
    input: `Text to translate:\n${wrapUntrusted('text', input.text)}`,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        translations: { type: 'object', additionalProperties: false, properties: Object.fromEntries(targets.map((l) => [l, { type: 'string' }])), required: targets },
      },
      required: ['translations'],
    },
  });
  const parsed = safeParseModelJson(reply, REPLY, { translations: {} });
  const out: LocaleMap = {};
  for (const l of targets) {
    const t = parsed.translations[l];
    if (typeof t === 'string' && t.trim()) out[l] = t.trim();
  }
  return out;
}
