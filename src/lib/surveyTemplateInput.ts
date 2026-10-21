// A built-in instrument → a survey (#1877) — client-safe. The one place that
// turns a template of src/lib/surveyTemplates.ts into the `createSurvey` input
// of src/lib/surveys.ts, so the admin picker and the first-destination
// campaign (#1912) instantiate an instrument the same way.
//
// THE RULES
//   • Every label is copied in all three languages, resolved now — the survey
//     row holds the wording, exactly like a newsletter issue holds its copy.
//   • The template vocabulary maps onto the form engine's: SINGLE_CHOICE is a
//     SELECT. A choice's stored value is its code (`optionValues`) where the
//     template has one, otherwise its position — the template's own contract.
//   • A question may carry a mentor wording. One survey row has ONE wording per
//     question, so an instrument that carries one cannot be sent to BOTH roles
//     as one survey: a mentor would read the mentee's question. That audience
//     is refused (`allowedAudiences`), and the admin creates one survey per role.

import { getSurveyTemplate, renderSurveyTemplate, type SurveyTemplate } from '@/lib/surveyTemplates';
import type { Locale } from '@/i18n/config';

export type InstrumentAudience = 'MENTEE' | 'MENTOR' | 'BOTH';
export type InstrumentAnonymity = 'IDENTIFIED' | 'CONFIDENTIAL' | 'ANONYMOUS';

const LOCALES: Locale[] = ['en', 'tr', 'de'];

/** True when some question words itself differently for a mentor. */
export function hasRoleWording(template: SurveyTemplate): boolean {
  return template.questions.some((q) => !!q.mentorLabel);
}

/** The audiences one survey made from this instrument can honestly address. */
export function allowedAudiences(template: SurveyTemplate): InstrumentAudience[] {
  if (template.audience === 'MENTEE') return ['MENTEE'];
  if (template.audience === 'MENTOR') return ['MENTOR'];
  return hasRoleWording(template) ? ['MENTEE', 'MENTOR'] : ['MENTEE', 'MENTOR', 'BOTH'];
}

/**
 * The `createSurvey` input for one instrument. Returns null for an unknown key
 * or an audience the instrument cannot address (see the rules above).
 */
export function surveyInputFromTemplate(
  templateKey: string,
  opts: { audience?: InstrumentAudience; anonymity?: InstrumentAnonymity } = {},
) {
  const template = getSurveyTemplate(templateKey);
  if (!template) return null;
  const audience = opts.audience ?? (template.audience === 'BOTH' && hasRoleWording(template) ? 'MENTEE' : template.audience);
  if (!allowedAudiences(template).includes(audience)) return null;
  const role = audience === 'MENTOR' ? 'MENTOR' : 'MENTEE';
  const [en, tr, de] = LOCALES.map((l) => renderSurveyTemplate(template, l, role));
  const tri = (pick: (r: typeof en) => string) => ({ en: pick(en), tr: pick(tr), de: pick(de) });
  return {
    key: template.key,
    templateKey: template.key,
    title: tri((r) => r.title),
    intro: tri((r) => r.description),
    audience,
    anonymity: opts.anonymity ?? template.anonymityDefault,
    questions: template.questions.map((q, i) => ({
      key: q.key,
      type: q.type === 'SINGLE_CHOICE' ? 'SELECT' : q.type,
      labels: tri((r) => r.questions[i].label),
      ...(q.options
        ? { options: q.options.map((_, j) => ({ value: q.optionValues?.[j] ?? String(j), labels: tri((r) => r.questions[i].options![j]) })) }
        : {}),
      required: q.required,
      sortOrder: i,
    })),
  };
}
