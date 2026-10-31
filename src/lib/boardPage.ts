// How GET /api/mentorship pages the pipeline board (#1438). Dependency-free so
// the rule is unit-tested without a database (scripts/test/board-page.test.mjs).
//
// The board used to download every relation in the programme in one request
// and render all of it: 243 KB, 308 cards and 9 429 DOM nodes at 308 relations,
// growing linearly. With `view=board` the server answers each column's TRUE
// count plus only its first page of cards; a column loads further pages on
// demand (`stage=<key>&page=<n>`).

/** Cards per column per request. */
export const BOARD_PAGE_SIZE = 20;
/** The most one column request may ask for. */
export const BOARD_PAGE_MAX = 100;
/** A stage key is a string column (custom stages, #747) — bounded, never trusted further than a WHERE value. */
const STAGE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export interface BoardPage {
  /** One column's page, or null for "every column's first page". */
  stage: string | null;
  page: number;
  perStage: number;
}

function positiveInt(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 ? n : null;
}

/** Read `stage`, `page` and `pageSize` for the board view. An invalid stage key is null → a 400 at the route. */
export function boardPageParams(params: URLSearchParams): BoardPage | { error: 'invalid_stage' } {
  const rawStage = params.get('stage');
  if (rawStage !== null && !STAGE_KEY.test(rawStage)) return { error: 'invalid_stage' };
  const perStage = Math.min(BOARD_PAGE_MAX, positiveInt(params.get('pageSize')) ?? BOARD_PAGE_SIZE);
  // A page beyond the first only means something inside one column.
  const page = rawStage ? (positiveInt(params.get('page')) ?? 1) : 1;
  return { stage: rawStage, page, perStage };
}

/**
 * Whether the plain list is paged. It used to page only when `page` was passed,
 * so `?pageSize=20` alone was SILENTLY ignored and returned the full list — a
 * caller asking for a page believed it had one. Either parameter now pages.
 */
export function listIsPaged(params: URLSearchParams): boolean {
  return params.get('page') !== null || params.get('pageSize') !== null;
}

// ── The e-mail composer's recipient list (#1438) ─────────────────────────────
// `view=recipients` is the composer's own narrow read: a relation id and its
// mentee's name and language, nothing else (no e-mail, no counts). One page at
// a time for the list on screen; `all=1` answers every match for "select all
// matching", bounded so a mistyped filter cannot ask for the whole database.

/** Rows per page of the recipient list. */
export const RECIPIENT_PAGE_SIZE = 50;
/** The most "select all matching" will return in one answer. */
export const RECIPIENT_ALL_MAX = 2000;

export interface RecipientPage {
  all: boolean;
  page: number;
  take: number;
  /** One relation, for the composer's prefill link (?relation=<id>). */
  relationId: string | null;
}

export function recipientPageParams(params: URLSearchParams): RecipientPage {
  const all = params.get('all') === '1';
  const rawRelation = params.get('relation');
  const relationId = rawRelation && /^[A-Za-z0-9_-]{1,64}$/.test(rawRelation) ? rawRelation : null;
  const page = all ? 1 : (positiveInt(params.get('page')) ?? 1);
  return { all, page, take: all ? RECIPIENT_ALL_MAX : RECIPIENT_PAGE_SIZE, relationId };
}
