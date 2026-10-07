// Authoring assist and paste-in enrichment (#2055, part 2). Server-only; the
// client, model and caps are callModel's. Callers MUST go through runAiGated.
//
// Everything here returns a PROPOSAL: a draft for an editor, or field values a
// person accepts one by one. Nothing is saved, published, queued or sent by
// these functions or the routes that serve them. No URL is fetched and no
// external profile is scraped — the only input is text a person pasted, fenced
// as untrusted data (#2026).

import { z } from 'zod';
import { callModel, safeParseModelJson } from '@/lib/ai/provider';
import { wrapUntrusted } from '@/lib/ai/untrusted';
import { locales } from '@/i18n/config';
import { capSkills } from '@/lib/skills';
import { TEXT_LIMITS } from '@/lib/textLimits';
import type { LocaleMap, TranslationPurpose } from '@/lib/machineTranslation';

const DRAFT_PURPOSE: Record<TranslationPurpose, string> = {
  announcement: 'an announcement from the programme team to its mentees and mentors: 2-5 short sentences, warm and direct, one clear call to action if the brief has one',
  goal_template: 'ONE goal a mentee works towards: an imperative of at most 12 words, concrete and checkable ("Add two measurable results to your CV")',
  message_template: 'a reusable reply a mentor inserts into a chat with a mentee: 1-3 friendly sentences, may use the placeholder {name} for the mentee’s first name',
};

const LOCALE_SCHEMA = { type: 'object', additionalProperties: false, properties: Object.fromEntries(locales.map((l) => [l, { type: 'string' }])), required: [...locales] } as const;
const LOCALE_REPLY = z.object(Object.fromEntries(locales.map((l) => [l, z.string()])) as Record<(typeof locales)[number], z.ZodString>).partial();

/** A draft in all three languages from a short brief. A draft for the editor, never sent. */
export async function draftContent(input: { brief: string; purpose: TranslationPurpose }): Promise<LocaleMap> {
  const reply = await callModel({
    task: 'content_draft',
    system:
      `You draft text for a mentoring and internship programme team. Write ${DRAFT_PURPOSE[input.purpose]}. ` +
      'Write it three times, with the same meaning: English (en), Turkish (tr) and German (de); in Turkish and German address the reader informally (sen / du). ' +
      'Use only what the brief says — never invent dates, links, names, numbers or promises. Return ONLY JSON {"en": "...", "tr": "...", "de": "..."}.',
    input: `Brief from the programme team:\n${wrapUntrusted('brief', input.brief)}`,
    jsonSchema: LOCALE_SCHEMA,
  });
  const parsed = safeParseModelJson(reply, LOCALE_REPLY, {});
  const out: LocaleMap = {};
  for (const l of locales) {
    const t = parsed[l];
    if (typeof t === 'string' && t.trim()) out[l] = t.trim().slice(0, TEXT_LIMITS.announcementText);
  }
  return out;
}

export interface MentorProfileProposal {
  bio: string;
  skills: string[];
  interests: string;
}

const MENTOR_REPLY = z.object({ bio: z.string(), skills: z.array(z.string()), interests: z.string() }).partial();

/** Proposed bio, expertise and interests from a mentor's own pasted career summary. */
export async function enrichMentorProfile(text: string): Promise<MentorProfileProposal> {
  const reply = await callModel({
    task: 'profile_enrich',
    system:
      'A mentor pasted their own career summary. Propose profile fields for them, in the language the summary is written in: ' +
      '"bio" — 2-4 sentences in the first person, what they do and how they can help a student or junior; ' +
      '"skills" — 5-15 canonical skill names they clearly have; ' +
      '"interests" — one short comma-separated line of topics they would enjoy mentoring on. ' +
      'Use only what the summary says. Return ONLY JSON.',
    input: `Career summary:\n${wrapUntrusted('summary', text)}`,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { bio: { type: 'string' }, skills: { type: 'array', items: { type: 'string' } }, interests: { type: 'string' } },
      required: ['bio', 'skills', 'interests'],
    },
  });
  const p = safeParseModelJson(reply, MENTOR_REPLY, {});
  return {
    bio: String(p.bio ?? '').trim().slice(0, TEXT_LIMITS.bio),
    skills: capSkills(Array.isArray(p.skills) ? p.skills : []),
    interests: String(p.interests ?? '').trim().slice(0, 500),
  };
}

export interface CompanyProposal {
  description: string;
  industry: string;
}

const COMPANY_REPLY = z.object({ description: z.string(), industry: z.string() }).partial();

/** Proposed description and sector from text an admin pasted about a company. */
export async function enrichCompany(text: string): Promise<CompanyProposal> {
  const reply = await callModel({
    task: 'company_enrich',
    system:
      'An admin pasted text about a company that hosts interns. Propose two fields, in the language of the text: ' +
      '"description" — 2-4 neutral sentences on what the company does and what an intern would work on; ' +
      '"industry" — the sector in 1-3 words. Use only what the text says. Return ONLY JSON.',
    input: `About the company:\n${wrapUntrusted('company', text)}`,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { description: { type: 'string' }, industry: { type: 'string' } },
      required: ['description', 'industry'],
    },
  });
  const p = safeParseModelJson(reply, COMPANY_REPLY, {});
  return {
    description: String(p.description ?? '').trim().slice(0, 2000),
    industry: String(p.industry ?? '').trim().slice(0, TEXT_LIMITS.companyIndustry),
  };
}
