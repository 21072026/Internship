import { type Locale } from '@/i18n/config';
import { getDictionary, type Dictionary } from '@/i18n/dictionaries';

/**
 * The built-in survey instrument library (#1883) — six ready instruments in
 * EN/TR/DE.
 *
 * WHY THE CONTENT SHIPS IN THE REPO
 *
 * An admin should pick a survey, not write one. A builder with an empty canvas
 * is how a feedback module dies: nobody opening `/admin` on a Tuesday
 * afternoon has three languages of well-worded survey questions in their head.
 * So the library ships filled, the same way the newsletter one does
 * (`src/lib/newsletterContent.ts`) and the document templates do
 * (`src/lib/templates.ts`).
 *
 * THREE QUESTIONS PLUS AN NPS ITEM — THE HARD CAP
 *
 * Carried over from #836: more questions means fewer responses. Every
 * instrument here is at most three questions plus one NPS item, and the open
 * text counts as one of the three. A PR that "improves" an instrument by adding
 * a fifth question to collect a bit more data should be pushed back on in
 * review — short is the feature, not a limitation of it.
 *
 * HOW THE WORDING IS RESOLVED
 *
 * A label is a *selector into the shared dictionary*, not an inline
 * `{en,tr,de}` map. The NPS question, its scale anchors and the four
 * role-specific program questions were already written and translated
 * (`programSurvey` in `src/i18n/dictionaries.ts`); a selector reuses those
 * strings instead of copying them, so re-wording one reaches every instrument
 * that asks it. New wording goes into the `surveyTemplates` namespace of all
 * three dictionaries.
 *
 * CLIENT-SAFE ON PURPOSE
 *
 * This file imports nothing from Prisma and nothing from `node:*`, so a future
 * admin picker can render a live preview of an instrument in the browser. The
 * types below are plain string unions that line up with the `Survey` /
 * `SurveyQuestion` columns coming in #1879 — creating a survey from a template
 * copies the resolved wording into the row, exactly like the newsletter does.
 */

/** Who an instrument is addressed to. Mirrors `SurveyAudience` (#1879). */
export type SurveyAudience = 'MENTEE' | 'MENTOR' | 'BOTH';

/** Mirrors `SurveyAnonymity` (#1879); a template only carries the default. */
export type SurveyAnonymity = 'IDENTIFIED' | 'CONFIDENTIAL' | 'ANONYMOUS';

/** Mirrors the question types these instruments need (#1879). */
export type SurveyQuestionType = 'NPS' | 'SCALE' | 'SINGLE_CHOICE' | 'TEXT';

export type SurveyTemplateKey =
  | 'program_pre'
  | 'program_mid'
  | 'program_post'
  | 'pulse'
  | 'nps_only'
  | 'post_meeting';

/** A dictionary selector — see "HOW THE WORDING IS RESOLVED" above. */
type Text = (d: Dictionary) => string;

export interface SurveyTemplateQuestion {
  /** Stable answer join key; never renamed once an instrument has shipped. */
  key: string;
  type: SurveyQuestionType;
  label: Text;
  /**
   * The mentor wording for the same slot, where a mentor is genuinely being
   * asked a different thing. Its presence is what makes an instrument `BOTH`
   * rather than two near-identical instruments.
   */
  mentorLabel?: Text;
  /** Inclusive bounds for `SCALE` (an `NPS` item is always 0–10). */
  scale?: { min: number; max: number };
  /** Anchor wording for the low and the high end of a scale. */
  scaleLabels?: { low: Text; high: Text };
  /** Choices for `SINGLE_CHOICE`, in the order they are shown. */
  options?: Text[];
  required: boolean;
}

export interface SurveyTemplate {
  key: SurveyTemplateKey;
  audience: SurveyAudience;
  /** What the admin picker preselects; still changeable per survey. */
  anonymityDefault: SurveyAnonymity;
  title: Text;
  description: Text;
  questions: SurveyTemplateQuestion[];
}

/** The cap stated at the top of this file, in code so a reviewer can cite it. */
export const SURVEY_TEMPLATE_MAX_QUESTIONS = 3;

const FIVE_POINT: Pick<SurveyTemplateQuestion, 'scale' | 'scaleLabels'> = {
  scale: { min: 1, max: 5 },
  scaleLabels: {
    low: (d) => d.surveyTemplates.scale.low,
    high: (d) => d.surveyTemplates.scale.high,
  },
};

/** The already-shipped NPS item, identical wherever it is asked. */
const NPS_ITEM: SurveyTemplateQuestion = {
  key: 'nps',
  type: 'NPS',
  label: (d) => d.programSurvey.npsQuestion,
  scale: { min: 0, max: 10 },
  scaleLabels: {
    low: (d) => d.programSurvey.scaleLow,
    high: (d) => d.programSurvey.scaleHigh,
  },
  required: true,
};

const NPS_WHY: SurveyTemplateQuestion = {
  key: 'nps_why',
  type: 'TEXT',
  label: (d) => d.surveyTemplates.programPost.q.npsWhy,
  required: false,
};

export const SURVEY_TEMPLATES: SurveyTemplate[] = [
  {
    key: 'program_pre',
    audience: 'BOTH',
    // A baseline is only worth asking if it can be compared with the closing
    // survey for the same person, so this one is identified by default.
    anonymityDefault: 'IDENTIFIED',
    title: (d) => d.surveyTemplates.programPre.title,
    description: (d) => d.surveyTemplates.programPre.description,
    questions: [
      {
        key: 'goals',
        type: 'TEXT',
        label: (d) => d.surveyTemplates.programPre.q.goals,
        mentorLabel: (d) => d.surveyTemplates.programPre.q.goalsMentor,
        required: true,
      },
      {
        key: 'confidence',
        type: 'SCALE',
        label: (d) => d.surveyTemplates.programPre.q.confidence,
        ...FIVE_POINT,
        required: true,
      },
      {
        key: 'concerns',
        type: 'TEXT',
        label: (d) => d.surveyTemplates.programPre.q.concerns,
        required: false,
      },
    ],
  },
  {
    key: 'program_mid',
    audience: 'BOTH',
    anonymityDefault: 'CONFIDENTIAL',
    title: (d) => d.surveyTemplates.programMid.title,
    description: (d) => d.surveyTemplates.programMid.description,
    questions: [
      {
        key: 'progress',
        type: 'SCALE',
        label: (d) => d.surveyTemplates.programMid.q.progress,
        ...FIVE_POINT,
        required: true,
      },
      {
        // "Was the help there when you needed it?" — a mentee means their
        // mentor, a mentor means the program. Both strings already shipped.
        key: 'support',
        type: 'SCALE',
        label: (d) => d.programSurvey.mentee.communication,
        mentorLabel: (d) => d.programSurvey.mentor.support,
        ...FIVE_POINT,
        required: true,
      },
      {
        key: 'blockers',
        type: 'TEXT',
        label: (d) => d.surveyTemplates.programMid.q.blockers,
        required: false,
      },
    ],
  },
  {
    key: 'program_post',
    audience: 'BOTH',
    anonymityDefault: 'CONFIDENTIAL',
    title: (d) => d.surveyTemplates.programPost.title,
    description: (d) => d.surveyTemplates.programPost.description,
    questions: [
      {
        // The closing "did this work for you?" differs by role: a mentee is
        // asked about expectations, a mentor about a sustainable workload.
        key: 'outcome',
        type: 'SCALE',
        label: (d) => d.programSurvey.mentee.expectations,
        mentorLabel: (d) => d.programSurvey.mentor.workloadSustainability,
        ...FIVE_POINT,
        required: true,
      },
      NPS_ITEM,
      NPS_WHY,
    ],
  },
  {
    key: 'pulse',
    audience: 'BOTH',
    anonymityDefault: 'CONFIDENTIAL',
    title: (d) => d.surveyTemplates.pulse.title,
    description: (d) => d.surveyTemplates.pulse.description,
    // Two questions, deliberately: this is the one that goes out on a repeating
    // cadence, and a recurring survey is answered only while it stays trivial.
    questions: [
      {
        key: 'mood',
        type: 'SCALE',
        label: (d) => d.surveyTemplates.pulse.q.mood,
        ...FIVE_POINT,
        required: true,
      },
      {
        key: 'need_help',
        type: 'SINGLE_CHOICE',
        label: (d) => d.surveyTemplates.pulse.q.needHelp,
        options: [
          (d) => d.surveyTemplates.pulse.options.allGood,
          (d) => d.surveyTemplates.pulse.options.smallThing,
          (d) => d.surveyTemplates.pulse.options.contactMe,
        ],
        required: true,
      },
    ],
  },
  {
    key: 'nps_only',
    audience: 'BOTH',
    anonymityDefault: 'ANONYMOUS',
    title: (d) => d.surveyTemplates.npsOnly.title,
    description: (d) => d.surveyTemplates.npsOnly.description,
    questions: [NPS_ITEM, NPS_WHY],
  },
  {
    key: 'post_meeting',
    audience: 'BOTH',
    anonymityDefault: 'CONFIDENTIAL',
    title: (d) => d.surveyTemplates.postMeeting.title,
    description: (d) => d.surveyTemplates.postMeeting.description,
    questions: [
      {
        key: 'helpfulness',
        type: 'SCALE',
        label: (d) => d.surveyTemplates.postMeeting.q.helpfulness,
        ...FIVE_POINT,
        required: true,
      },
      {
        key: 'note',
        type: 'TEXT',
        label: (d) => d.surveyTemplates.postMeeting.q.note,
        required: false,
      },
    ],
  },
];

export function listSurveyTemplates(): SurveyTemplate[] {
  return SURVEY_TEMPLATES;
}

export function getSurveyTemplate(key: string): SurveyTemplate | undefined {
  return SURVEY_TEMPLATES.find((t) => t.key === key);
}

// The shape a picker or a preview consumes: every selector already applied, so
// the functions above never reach a React prop or a Prisma write.
export interface ResolvedSurveyQuestion {
  key: string;
  type: SurveyQuestionType;
  label: string;
  scale?: { min: number; max: number };
  scaleLabels?: { low: string; high: string };
  options?: string[];
  required: boolean;
}

export interface ResolvedSurveyTemplate {
  key: SurveyTemplateKey;
  audience: SurveyAudience;
  anonymityDefault: SurveyAnonymity;
  title: string;
  description: string;
  questions: ResolvedSurveyQuestion[];
}

/**
 * Resolve one instrument into plain strings. `role` picks the mentor wording
 * where a question carries one; anything else gets the default label.
 */
export function renderSurveyTemplate(
  template: SurveyTemplate,
  locale: Locale,
  role: 'MENTEE' | 'MENTOR' = 'MENTEE'
): ResolvedSurveyTemplate {
  const d = getDictionary(locale);
  return {
    key: template.key,
    audience: template.audience,
    anonymityDefault: template.anonymityDefault,
    title: template.title(d),
    description: template.description(d),
    questions: template.questions.map((q) => ({
      key: q.key,
      type: q.type,
      label: role === 'MENTOR' && q.mentorLabel ? q.mentorLabel(d) : q.label(d),
      ...(q.scale ? { scale: q.scale } : {}),
      ...(q.scaleLabels
        ? { scaleLabels: { low: q.scaleLabels.low(d), high: q.scaleLabels.high(d) } }
        : {}),
      ...(q.options ? { options: q.options.map((o) => o(d)) } : {}),
      required: q.required,
    })),
  };
}
