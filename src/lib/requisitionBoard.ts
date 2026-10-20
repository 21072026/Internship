// The per-requisition applicant board (#1838) — the pure half: how the query
// string becomes filters, and what a card shows about skills and screening
// answers. No Prisma import, so the page and the unit spec read the same rules
// the route applies.
//
// What the route keeps for itself: the requisition ownership check (a company
// sees only its own requisitions — another company's is a 404, never a 403
// that confirms the id), the counts (a `groupBy`, never the length of a fetched
// page) and the SQL that runs the filters.
import { APPLICATION_STAGES, isApplicationStage, type ApplicationStage } from '@/lib/applications';
import { skillKey } from '@/lib/skills';

export const BOARD_PAGE_SIZE_DEFAULT = 20;
export const BOARD_PAGE_SIZE_MAX = 50;
/** More than this many `answer.<id>=` filters is refused rather than silently cut. */
export const BOARD_ANSWER_FILTERS_MAX = 5;

/**
 * A screening question id as it may appear in a JSON path. `screeningAnswers`
 * is an object keyed by question id (`{ [questionId]: string | boolean }`), so
 * the id ends up inside `$."<id>"` — the alphabet is what keeps the path a
 * path.
 */
const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface BoardFilters {
  /** Only this column's rows (and only its count is still computed for every column). */
  stage: ApplicationStage | null;
  skill: string | null;
  city: string | null;
  q: string | null;
  answers: { questionId: string; value: string | boolean }[];
  /** Page through ONE column: rows of this stage only, no counts. */
  column: ApplicationStage | null;
  page: number;
  pageSize: number;
}

export type BoardFilterError = 'unknown_stage' | 'invalid_answer_filter' | 'too_many_answer_filters';

function clean(value: string | null, max: number): string | null {
  const trimmed = (value ?? '').trim().slice(0, max);
  return trimmed || null;
}

export function parseBoardFilters(params: URLSearchParams): { ok: true; filters: BoardFilters } | { ok: false; code: BoardFilterError } {
  const stageRaw = clean(params.get('stage'), 32);
  const columnRaw = clean(params.get('column'), 32);
  if ((stageRaw && !isApplicationStage(stageRaw)) || (columnRaw && !isApplicationStage(columnRaw))) return { ok: false, code: 'unknown_stage' };
  const answers: BoardFilters['answers'] = [];
  for (const [key, raw] of params.entries()) {
    if (!key.startsWith('answer.')) continue;
    const questionId = key.slice('answer.'.length);
    const value = raw.trim().slice(0, 200);
    if (!QUESTION_ID.test(questionId) || !value) return { ok: false, code: 'invalid_answer_filter' };
    answers.push({ questionId, value: value === 'true' ? true : value === 'false' ? false : value });
  }
  if (answers.length > BOARD_ANSWER_FILTERS_MAX) return { ok: false, code: 'too_many_answer_filters' };
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(BOARD_PAGE_SIZE_MAX, Math.max(1, Number.parseInt(params.get('pageSize') ?? '', 10) || BOARD_PAGE_SIZE_DEFAULT));
  return {
    ok: true,
    filters: {
      stage: (stageRaw as ApplicationStage | null) ?? null,
      skill: clean(params.get('skill'), 60),
      city: clean(params.get('city'), 100),
      q: clean(params.get('q'), 100),
      answers,
      column: (columnRaw as ApplicationStage | null) ?? null,
      page,
      pageSize,
    },
  };
}

/** The JSON path of one screening answer — only ever built from an id that passed QUESTION_ID. */
export function answerPath(questionId: string): string {
  if (!QUESTION_ID.test(questionId)) throw new Error('invalid question id');
  return `$."${questionId}"`;
}

/** Which columns a request loads rows for: one when paging or filtering by stage, otherwise all of them. */
export function columnsToLoad(filters: Pick<BoardFilters, 'stage' | 'column'>): readonly ApplicationStage[] {
  const only = filters.column ?? filters.stage;
  return only ? [only] : APPLICATION_STAGES;
}

/** The candidate's skills that the requisition asks for, in the candidate's spelling, Turkish-aware. */
export function matchedSkills(candidateSkills: unknown, requiredSkills: unknown): string[] {
  if (!Array.isArray(candidateSkills) || !Array.isArray(requiredSkills)) return [];
  const wanted = new Set(requiredSkills.filter((s): s is string => typeof s === 'string').map(skillKey));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const skill of candidateSkills) {
    if (typeof skill !== 'string') continue;
    const key = skillKey(skill);
    if (wanted.has(key) && !seen.has(key)) { seen.add(key); out.push(skill); }
  }
  return out;
}

/** How many screening questions the applicant answered — the card's summary; the drawer has room for the rest. */
export function answeredCount(screeningAnswers: unknown): number {
  if (!screeningAnswers || typeof screeningAnswers !== 'object' || Array.isArray(screeningAnswers)) return 0;
  return Object.values(screeningAnswers as Record<string, unknown>).filter((v) => v !== null && v !== undefined && v !== '').length;
}
