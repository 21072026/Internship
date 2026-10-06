// Paging a message thread (#1609). Client-safe and dependency-free on purpose:
// the server encodes cursors with it, the thread view merges pages with it, and
// scripts/test/message-page.test.mjs pins both without Next or a database.
//
// THE CURSOR
//   A thread is read newest-first in keyset order — (createdAt DESC, id DESC) —
//   and the cursor is the last row of a page: `<createdAt ms>_<id>`. A keyset
//   cursor, not an offset: a message arriving while someone scrolls back does
//   not shift the next page by one (an offset would show a duplicate), and a
//   message deleted meanwhile does not skip one. It carries its own values
//   rather than naming a row to look up, so a cursor row that was hidden or
//   erased since still pages correctly.
//
// THE MERGE
//   The view polls the NEWEST page (live signals, ticks) while the person may
//   have scrolled back through older ones. `mergeNewestPage` folds a fresh
//   newest page onto what is on screen without dropping the older pages and
//   without opening a gap: if the fresh page no longer overlaps what was loaded
//   (more than a page arrived between two polls), it starts over from the fresh
//   page instead of showing two runs with a hole between them.

export const MESSAGE_PAGE_DEFAULT = 50;
export const MESSAGE_PAGE_MAX = 100;

/** `?limit=` → a page size: default 50, clamped to 1..100, garbage reads as the default. */
export function parsePageLimit(raw: string | null | undefined): number {
  if (raw == null || raw === '') return MESSAGE_PAGE_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return MESSAGE_PAGE_DEFAULT;
  return Math.min(MESSAGE_PAGE_MAX, Math.max(1, Math.floor(n)));
}

export interface PageCursor {
  createdAt: Date;
  id: string;
}

export function encodePageCursor(row: { createdAt: Date | string; id: string }): string {
  return `${new Date(row.createdAt).getTime()}_${row.id}`;
}

/** The cursor back, or null for anything that is not one (the route answers 400). */
export function decodePageCursor(raw: string | null | undefined): PageCursor | null {
  if (!raw) return null;
  const m = /^(\d{1,15})_([A-Za-z0-9]{1,64})$/.exec(raw);
  if (!m) return null;
  const createdAt = new Date(Number(m[1]));
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: m[2] };
}

/** The Prisma `where` fragment for "strictly older than the cursor" in keyset order. */
export function olderThan(cursor: PageCursor) {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

/**
 * One page out of a newest-first read of `limit + 1` rows: the page in display
 * order (oldest first), whether there is more, and the cursor to ask for it.
 */
export function toPage<T extends { createdAt: Date | string; id: string }>(
  rowsNewestFirst: T[],
  limit: number,
): { messages: T[]; hasMore: boolean; nextCursor: string | null } {
  const hasMore = rowsNewestFirst.length > limit;
  const page = rowsNewestFirst.slice(0, limit);
  const oldest = page[page.length - 1];
  return {
    messages: page.reverse(),
    hasMore,
    nextCursor: hasMore && oldest ? encodePageCursor(oldest) : null,
  };
}

interface Row {
  id: string;
  createdAt: string | Date;
}

function before(a: Row, b: Row): boolean {
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  return ta < tb || (ta === tb && a.id < b.id);
}

/**
 * Fold a freshly fetched NEWEST page onto the messages on screen (both oldest
 * first). The fresh page wins for every message it covers — an edit, a
 * deletion, a reaction shows up — and older pages the person scrolled back to
 * stay. With no overlap and more history behind the fresh page, keeping the old
 * run would show a hole, so the fresh page replaces everything.
 */
export function mergeNewestPage<T extends Row>(onScreen: T[], fresh: T[], freshHasMore: boolean): T[] {
  if (!freshHasMore || fresh.length === 0 || onScreen.length === 0) return fresh;
  const freshIds = new Set(fresh.map((m) => m.id));
  if (!onScreen.some((m) => freshIds.has(m.id))) return fresh;
  const oldestFresh = fresh[0];
  const older = onScreen.filter((m) => !freshIds.has(m.id) && before(m, oldestFresh));
  return [...older, ...fresh];
}

/** Prepend an older page (oldest first) to what is on screen, never duplicating a message. */
export function prependOlderPage<T extends Row>(onScreen: T[], older: T[]): T[] {
  const have = new Set(onScreen.map((m) => m.id));
  return [...older.filter((m) => !have.has(m.id)), ...onScreen];
}

/**
 * `q` as text for a Prisma `contains` on MySQL. Prisma passes the value into
 * LIKE '%…%' unescaped, so a `%` or `_` someone types would be a wildcard ("%%"
 * matched every message); backslash is MySQL's LIKE escape and goes first.
 */
export function likeLiteral(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A short excerpt of `body` around the first case-insensitive match of
 * `query`, with an ellipsis on whichever side was cut. No match (the database
 * collation matched where a plain lower-case comparison does not, e.g. an
 * accent) falls back to the start of the body.
 */
export function searchSnippet(body: string, query: string, width = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  const at = flat.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  if (at < 0) return `${flat.slice(0, width).trimEnd()}…`;
  const start = Math.max(0, Math.min(at - Math.floor((width - query.length) / 2), flat.length - width));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}
