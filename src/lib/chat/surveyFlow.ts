// Answering a survey in chat (#1953) — the pure half: which questions a button
// can answer, the buttons each one offers, and the answers-so-far carried in
// the button's own value. No I/O; unit-tested in e2e/chat-survey-flow.unit.spec.ts.
//
// WHY THE STATE RIDES IN THE BUTTON. A chat answer arrives one click at a time,
// but the survey engine takes a response whole (submitSurveyResponse validates
// every required question at once and claims the invitation in the same
// transaction). Carrying the answers so far in the next button's value keeps
// the engine's single write intact and needs no half-answered row anywhere —
// nothing is stored until the last click submits. The value is the clicker's
// own claim about their own answers; the engine validates it like any other.
//
// WHAT A BUTTON CANNOT ANSWER. Free text, a number, a date, a multi-select: a
// survey with any of those is not answered in chat at all — the card sends the
// person to the survey page instead of submitting part of it.

import { NPS_SCALE, pickLocalized } from '@/lib/surveySchema';
import { DEFAULT_SCALE } from '@/lib/forms/schema';

export interface FlowQuestion {
  key: string;
  type: string;
  required: boolean;
  labels: unknown;
  options: unknown;
}

export interface FlowChoice {
  label: string;
  value: string | number | boolean;
}

const BUTTON_TYPES = new Set(['SELECT', 'BOOLEAN', 'SCALE', 'NPS']);
/** Slack renders up to 25 elements in one actions block; NPS needs 11, a long SELECT is capped here. */
export const MAX_CHOICES = 11;

export function isButtonAnswerable(q: Pick<FlowQuestion, 'type' | 'options'>): boolean {
  if (!BUTTON_TYPES.has(q.type)) return false;
  if (q.type === 'SELECT') return Array.isArray(q.options) && q.options.length > 0 && q.options.length <= MAX_CHOICES;
  return true;
}

/** Can the whole survey be answered with buttons? Otherwise the card links to the page. */
export function answerableInChat(questions: Pick<FlowQuestion, 'type' | 'options'>[]): boolean {
  return questions.length > 0 && questions.every(isButtonAnswerable);
}

/** The buttons one question offers, labelled in `locale`. */
export function choicesFor(q: FlowQuestion, locale: string, yesNo: { yes: string; no: string }): FlowChoice[] {
  switch (q.type) {
    case 'BOOLEAN':
      return [
        { label: yesNo.yes, value: true },
        { label: yesNo.no, value: false },
      ];
    case 'SCALE':
    case 'NPS': {
      const { min, max } = q.type === 'NPS' ? NPS_SCALE : DEFAULT_SCALE;
      return Array.from({ length: max - min + 1 }, (_, i) => ({ label: String(min + i), value: min + i }));
    }
    case 'SELECT':
      return (q.options as { value: string; labels: unknown }[]).map((o) => ({ label: pickLocalized(o.labels, locale) || o.value, value: o.value }));
    default:
      return [];
  }
}

/** The answers so far plus the index of the next question — what a button carries. */
export interface FlowState {
  invitationId: string;
  next: number;
  answers: Record<string, string | number | boolean>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export function encodeState(state: FlowState): string {
  return `${state.invitationId}|${state.next}|${b64url(JSON.stringify(state.answers))}`;
}

/** null for anything that is not exactly what encodeState() writes. */
export function decodeState(value: string | null): FlowState | null {
  if (!value) return null;
  const [invitationId, nextRaw, packed, ...rest] = value.split('|');
  if (rest.length > 0 || !invitationId || !ID.test(invitationId) || !/^\d{1,3}$/.test(nextRaw ?? '') || packed === undefined) return null;
  try {
    const answers = JSON.parse(Buffer.from(packed, 'base64url').toString('utf8')) as unknown;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
    for (const v of Object.values(answers)) if (!['string', 'number', 'boolean'].includes(typeof v)) return null;
    return { invitationId, next: Number(nextRaw), answers: answers as FlowState['answers'] };
  } catch {
    return null;
  }
}
