// The /api/v1 contract (#1988, story #1979): ONE envelope, ONE error shape,
// ONE cursor and ONE list-query parser for every public endpoint, so the
// eighth endpoint does not invent its own.
//
//   success  → { data, page: { nextCursor, hasMore } }          (lists)
//              { data }                                          (single resource)
//   failure  → application/problem+json (RFC 9457) with a STABLE `type` slug
//              (API_ERROR_TYPES) a client switches on — never the English
//              `title`/`detail`, which may be reworded.
//
// The door itself — rate limit → key → scope → org binding → plan → quota —
// is withApiKey() in src/lib/apiKey.ts (#1546); every refusal it answers is
// built here. A route composes the two: `withApiKey(request, scope, (key) =>
// … apiOk(…))`.
//
// Cursors are opaque and tamper-evident: base64url of the keyset position
// `(updatedAt, id)` plus an HMAC that also binds the RESOURCE, so a cursor
// minted by one list is refused by another. A cursor that fails to decode is
// a `400 validation_failed` — never a silent fall-back to page one (the #831
// lesson: an unrecognised input is rejected, not given everything).
import { createHmac, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { requireServerSecret } from '@/lib/serverSecret';

export const API_ERROR_TYPES = [
  'invalid_api_key',
  'insufficient_scope',
  'org_unbound',
  'feature_locked',
  'rate_limited',
  'quota_exceeded',
  'validation_failed',
  'not_found',
  // Writes (#1994, src/lib/api/v1Write.ts).
  'idempotency_key_reused',
  'idempotency_in_progress',
  // A per-key cap was reached (#2002: subscriptions).
  'limit_reached',
  // Domain refusals of the writes (#1996).
  'duplicate_candidate',
  'invalid_transition',
  'stage_conflict',
  // A signed export link that is tampered, expired or no longer backed by its key (#3002).
  'invalid_link',
] as const;
export type ApiErrorType = (typeof API_ERROR_TYPES)[number];

export interface ApiFieldError {
  field: string;
  message: string;
}

/**
 * An RFC 9457 problem document. `error` repeats the human message under the
 * key the API answered with before #1988, so a client written against the old
 * `{ error }` body keeps reading something; `type` is what new clients read.
 */
export function apiError(
  status: number,
  type: ApiErrorType,
  title: string,
  detail?: string,
  extra?: { fields?: ApiFieldError[]; headers?: Record<string, string>; [key: string]: unknown },
): NextResponse {
  const { fields, headers, ...rest } = extra ?? {};
  const body: Record<string, unknown> = { type, title, status, error: detail ?? title, ...rest };
  if (detail) body.detail = detail;
  if (fields?.length) body.fields = fields;
  return NextResponse.json(body, {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...(headers ?? {}) },
  });
}

export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

/** The success envelope. `extra` is for a deprecated alias key, nothing else. */
export function apiOk<T>(data: T, page?: PageInfo, extra?: Record<string, unknown>, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data, ...(page ? { page } : {}), ...(extra ?? {}) }, init);
}

// ── Cursor ───────────────────────────────────────────────────────────────────

export interface CursorPosition {
  updatedAt: Date;
  id: string;
}

function sign(resource: string, payload: string): string {
  return createHmac('sha256', requireServerSecret())
    .update(`api-v1-cursor:${resource}:${payload}`)
    .digest('base64url')
    .slice(0, 22);
}

export function encodeCursor(resource: string, pos: CursorPosition): string {
  const payload = Buffer.from(JSON.stringify([pos.updatedAt.getTime(), pos.id])).toString('base64url');
  return `${payload}.${sign(resource, payload)}`;
}

/** The position, or null for anything that is not a cursor this resource minted. */
export function decodeCursor(resource: string, raw: string): CursorPosition | null {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot !== raw.lastIndexOf('.')) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(resource, payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [ms, id] = parsed;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || typeof id !== 'string' || !id) return null;
    return { updatedAt: new Date(ms), id };
  } catch {
    return null;
  }
}

// ── List query ───────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

// Strict ISO-8601 date-time with an explicit zone: `Date.parse` alone accepts
// "1", "March 3" and friends, and a delta sync silently keyed on a misread
// instant is worse than a 400.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface ListQuery {
  limit: number;
  cursor: CursorPosition | null;
  updatedSince: Date | null;
}

/**
 * `?limit` (default 50, clamped to 1…200 — over the maximum is clamped, not an
 * error), `?cursor` (opaque, from `page.nextCursor`) and `?updatedSince`
 * (ISO-8601 instant, inclusive). Answers the parsed query or the 400 to return.
 */
export function parseListQuery(request: Request, resource: string): ListQuery | NextResponse {
  const params = new URL(request.url).searchParams;
  const fields: ApiFieldError[] = [];

  let limit = DEFAULT_PAGE_LIMIT;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) fields.push({ field: 'limit', message: 'must be a positive integer' });
    else limit = Math.min(Number(rawLimit), MAX_PAGE_LIMIT);
  }

  let cursor: CursorPosition | null = null;
  const rawCursor = params.get('cursor');
  if (rawCursor !== null) {
    cursor = decodeCursor(resource, rawCursor);
    if (!cursor) fields.push({ field: 'cursor', message: 'is not a cursor issued by this list' });
  }

  let updatedSince: Date | null = null;
  const rawSince = params.get('updatedSince');
  if (rawSince !== null) {
    const ms = ISO_INSTANT.test(rawSince) ? Date.parse(rawSince) : NaN;
    if (Number.isNaN(ms)) fields.push({ field: 'updatedSince', message: 'must be an ISO-8601 date-time with a time zone' });
    else updatedSince = new Date(ms);
  }

  if (fields.length) return apiError(400, 'validation_failed', 'The request has invalid parameters', undefined, { fields });
  return { limit, cursor, updatedSince };
}

/**
 * The Prisma `where` fragment for a keyset page over `(updatedAt, id)`
 * ascending, plus the `updatedSince` floor. Ascending on purpose: a row edited
 * while a client walks the list moves to the END, so the walk meets it again
 * instead of skipping it.
 */
export function keysetWhere(query: Pick<ListQuery, 'cursor' | 'updatedSince'>) {
  const and: object[] = [];
  if (query.updatedSince) and.push({ updatedAt: { gte: query.updatedSince } });
  if (query.cursor) {
    and.push({
      OR: [
        { updatedAt: { gt: query.cursor.updatedAt } },
        { updatedAt: query.cursor.updatedAt, id: { gt: query.cursor.id } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

export const KEYSET_ORDER = [{ updatedAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * Cut a `take: limit + 1` result to the page and its page info.
 */
export function paginate<T extends { updatedAt: Date; id: string }>(
  resource: string,
  rows: T[],
  limit: number,
): { rows: T[]; page: PageInfo } {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    rows: pageRows,
    page: { nextCursor: hasMore && last ? encodeCursor(resource, last) : null, hasMore },
  };
}

/**
 * Equality filters a list accepts beyond the shared three (#1990). Each name
 * maps to its allowed values, or to 'string' for an id-like value. An
 * unrecognised value is a 400 — a filter that silently matched nothing (or
 * everything) would look like an empty or complete result.
 */
export function parseFilters<K extends string>(
  request: Request,
  spec: Record<K, readonly string[] | 'string'>,
): Partial<Record<K, string>> | NextResponse {
  const params = new URL(request.url).searchParams;
  const out: Partial<Record<K, string>> = {};
  const fields: ApiFieldError[] = [];
  for (const name of Object.keys(spec) as K[]) {
    const raw = params.get(name);
    if (raw === null) continue;
    const allowed = spec[name];
    if (allowed === 'string') {
      if (!raw || raw.length > 191) fields.push({ field: name, message: 'must be a non-empty value' });
      else out[name] = raw;
    } else if (!allowed.includes(raw)) {
      fields.push({ field: name, message: `must be one of ${allowed.join(', ')}` });
    } else out[name] = raw;
  }
  if (fields.length) return apiError(400, 'validation_failed', 'The request has invalid parameters', undefined, { fields });
  return out;
}

/** 404 for an id that is not this key's — another tenant's row looks exactly like a missing one. */
export function apiNotFound(): NextResponse {
  return apiError(404, 'not_found', 'Not found');
}
