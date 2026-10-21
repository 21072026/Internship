// Asynchronous exports of the /api/v1 read resources (#3002).
//
// A full snapshot should not have to come from walking the cursor page by page,
// so `POST /api/v1/exports { resource }` queues ONE job (`api.export`, run by
// the worker — never inline in the request) that writes every row of the key's
// organisation as gzipped NDJSON into an `ApiExport` row. The file is fetched
// only through a link that is HMAC-signed and short-lived; the row itself is
// deleted after `expiresAt`.
//
// Four rules are load-bearing:
//   - the SAME select, serializer and tenant filter as the resource's list
//     route (src/lib/api/v1Resources.ts), so an export can never carry a field
//     or a row the list would not — the note body included, which needs
//     `interactions:read_notes` exactly as it does there;
//   - the export row is the whole authority: the job payload is only its id,
//     and the org, key, resource and `withNotes` were fixed by the request;
//   - a link is a capability, so it is re-judged when it is used: the key that
//     made the export must still be live, still hold the resource's scope (and
//     `interactions:read_notes` for a file with notes), and its org must still
//     be entitled to the API. A revoked key's exports die with it;
//   - one export, one tenant: every read and write of `ApiExport` names `orgId`
//     or `apiKeyId` explicitly, never left to MT_ENFORCE_ISOLATION.
import { createHmac, timingSafeEqual } from 'crypto';
import { gzipSync } from 'zlib';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { requireServerSecret } from '@/lib/serverSecret';
import { entitled } from '@/lib/entitlements';
import { apiKeyStatus, parseScopes, type ApiScope } from '@/lib/apiScopes';
import { KEYSET_ORDER, keysetWhere, type CursorPosition } from '@/lib/api/v1';
import {
  candidateSelect,
  companySelect,
  interactionSelect,
  interviewRequestSelect,
  meetingOrgWhere,
  meetingSelect,
  offerSelect,
  relationshipSelect,
  requisitionSelect,
  serializeCandidate,
  serializeCompany,
  serializeInteraction,
  serializeInterviewRequest,
  serializeMeeting,
  serializeOffer,
  serializeRelationship,
  serializeRequisition,
} from '@/lib/api/v1Resources';

/** A finished file stays fetchable this long; then the row is deleted. */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
/** One signed link lives this long; GET /exports/{id} mints a fresh one. */
export const DOWNLOAD_LINK_TTL_MS = 15 * 60 * 1000;
/** Rows read per query while the file is written. */
const EXPORT_PAGE = 500;
/** More rows than this is a FAILED export (`too_many_rows`): page the list instead. */
export const EXPORT_ROW_CAP = 100_000;
/** A compressed file larger than this is a FAILED export (`too_large`). */
export const EXPORT_BYTE_CAP = 32 * 1024 * 1024;
/** Exports a key may have queued or running at once (409 `limit_reached`). */
export const MAX_OPEN_EXPORTS_PER_KEY = 3;

export type ExportStatus = 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';

type Row = { id: string; updatedAt: Date };
interface ExportResource {
  scope: ApiScope;
  /** One keyset page of the org's rows, serialized. */
  page(orgId: string, cursor: CursorPosition | null, withNotes: boolean): Promise<{ last: Row | null; items: object[] }>;
}

// Each entry mirrors its list route's `where` — the org anchor documented at
// the top of v1Resources.ts — and nothing else.
async function keyset<T extends Row>(rows: Promise<T[]>, serialize: (row: T) => object) {
  const list = await rows;
  return { last: list[list.length - 1] ?? null, items: list.map(serialize) };
}
const at = (cursor: CursorPosition | null) => keysetWhere({ cursor, updatedSince: null });
const page = { orderBy: KEYSET_ORDER, take: EXPORT_PAGE };

export const EXPORT_RESOURCES = {
  candidates: {
    scope: 'candidates:read',
    page: (orgId, cursor) =>
      keyset(prisma.user.findMany({ where: { role: 'MENTEE', orgId, ...at(cursor) }, ...page, select: candidateSelect }), serializeCandidate),
  },
  relationships: {
    scope: 'relationships:read',
    page: (orgId, cursor) =>
      keyset(prisma.mentorshipRelation.findMany({ where: { AND: [{ orgId }, at(cursor)] }, ...page, select: relationshipSelect }), serializeRelationship),
  },
  interactions: {
    scope: 'interactions:read',
    page: (orgId, cursor, withNotes) =>
      keyset(
        prisma.interactionLog.findMany({ where: { AND: [{ relation: { orgId } }, at(cursor)] }, ...page, select: interactionSelect(withNotes) }),
        (row) => serializeInteraction(row, withNotes),
      ),
  },
  meetings: {
    scope: 'meetings:read',
    page: (orgId, cursor) =>
      keyset(prisma.meeting.findMany({ where: { AND: [meetingOrgWhere(orgId), at(cursor)] }, ...page, select: meetingSelect }), serializeMeeting),
  },
  companies: {
    scope: 'companies:read',
    page: (orgId, cursor) =>
      keyset(prisma.company.findMany({ where: { AND: [{ orgId }, at(cursor)] }, ...page, select: companySelect }), serializeCompany),
  },
  requisitions: {
    scope: 'hiring:read',
    page: (orgId, cursor) =>
      keyset(prisma.requisition.findMany({ where: { AND: [{ orgId }, at(cursor)] }, ...page, select: requisitionSelect }), serializeRequisition),
  },
  offers: {
    scope: 'hiring:read',
    page: (orgId, cursor) =>
      keyset(prisma.offer.findMany({ where: { AND: [{ relation: { orgId } }, at(cursor)] }, ...page, select: offerSelect }), serializeOffer),
  },
  'interview-requests': {
    scope: 'hiring:read',
    page: (orgId, cursor) =>
      keyset(
        prisma.interviewRequest.findMany({ where: { AND: [{ orgId }, at(cursor)] }, ...page, select: interviewRequestSelect }),
        serializeInterviewRequest,
      ),
  },
} satisfies Record<string, ExportResource>;

export type ExportResourceName = keyof typeof EXPORT_RESOURCES;
export const EXPORT_RESOURCE_NAMES = Object.keys(EXPORT_RESOURCES) as [ExportResourceName, ...ExportResourceName[]];

export function isExportResource(value: string): value is ExportResourceName {
  return Object.prototype.hasOwnProperty.call(EXPORT_RESOURCES, value);
}

/** The scopes a key needs to make — and later to fetch — this export. */
export function exportScopes(resource: ExportResourceName, withNotes: boolean): ApiScope[] {
  const scope = EXPORT_RESOURCES[resource].scope as ApiScope;
  return withNotes ? [scope, 'interactions:read_notes'] : [scope];
}

// ── Signed links ─────────────────────────────────────────────────────────────

function signature(id: string, expiresMs: number): string {
  return createHmac('sha256', requireServerSecret()).update(`api-v1-export:${id}:${expiresMs}`).digest('base64url');
}

/** `?expires=<ms>&sig=<hmac>` for the download route. */
export function signDownload(id: string, expiresMs: number): { expires: string; sig: string } {
  return { expires: String(expiresMs), sig: signature(id, expiresMs) };
}

/** True only for a signature this server minted for this id and instant, not yet past. */
export function verifyDownload(id: string, expires: string | null, sig: string | null, now: number = Date.now()): boolean {
  if (!expires || !sig || !/^\d{1,15}$/.test(expires)) return false;
  const expiresMs = Number(expires);
  if (expiresMs <= now) return false;
  const expected = Buffer.from(signature(id, expiresMs));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ── The API object ───────────────────────────────────────────────────────────

export const exportSelect = {
  id: true,
  resource: true,
  status: true,
  withNotes: true,
  rowCount: true,
  byteSize: true,
  error: true,
  createdAt: true,
  finishedAt: true,
  expiresAt: true,
} satisfies Prisma.ApiExportSelect;

type ExportRow = Prisma.ApiExportGetPayload<{ select: typeof exportSelect }>;

/** The resource as GET /exports/{id} answers it; a READY one carries a fresh signed link. */
export function serializeExport(row: ExportRow, origin: string, now: number = Date.now()) {
  const base = {
    id: row.id,
    resource: row.resource,
    status: row.status as ExportStatus,
    includesNotes: row.withNotes,
    rowCount: row.rowCount,
    byteSize: row.byteSize,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
  };
  if (row.status !== 'READY') return base;
  const linkExpires = Math.min(now + DOWNLOAD_LINK_TTL_MS, row.expiresAt.getTime());
  const { expires, sig } = signDownload(row.id, linkExpires);
  return {
    ...base,
    downloadUrl: `${origin}/api/exports/${encodeURIComponent(row.id)}/download?expires=${expires}&sig=${sig}`,
    downloadExpiresAt: new Date(linkExpires).toISOString(),
  };
}

// ── The job ──────────────────────────────────────────────────────────────────

/**
 * The `api.export` handler. At-least-once safe: a READY or FAILED row is left
 * alone, and a RUNNING one (an attempt that died) is simply written again from
 * the start — the file is built in memory and stored in one guarded update, so
 * a half-written file never exists.
 */
export async function runApiExport(exportId: string, signal: AbortSignal): Promise<{ rows: number; bytes: number; skipped: number }> {
  // The row is what says which tenant this is; read it unbound, then bind.
  const row = await runWithOrg(null, () =>
    prisma.apiExport.findUnique({
      where: { id: exportId },
      select: { id: true, orgId: true, apiKeyId: true, resource: true, withNotes: true, status: true },
    }),
  );
  if (!row || (row.status !== 'PENDING' && row.status !== 'RUNNING')) return { rows: 0, bytes: 0, skipped: 1 };

  return runWithOrg(row.orgId, async () => {
    const claimed = await prisma.apiExport.updateMany({
      where: { id: row.id, orgId: row.orgId, status: { in: ['PENDING', 'RUNNING'] } },
      data: { status: 'RUNNING' },
    });
    if (claimed.count === 0) return { rows: 0, bytes: 0, skipped: 1 };

    const fail = async (error: string) => {
      await prisma.apiExport.updateMany({
        where: { id: row.id, orgId: row.orgId, status: 'RUNNING' },
        data: { status: 'FAILED', error, finishedAt: new Date(), content: null },
      });
      return { rows: 0, bytes: 0, skipped: 0 };
    };

    // The request was judged when it was made; the key may have lost it since.
    if (!isExportResource(row.resource) || !(await keyMayRead(row.apiKeyId, row.orgId, exportScopes(row.resource, row.withNotes)))) {
      return fail('key_inactive');
    }

    const resource = EXPORT_RESOURCES[row.resource] as ExportResource;
    const lines: string[] = [];
    let cursor: CursorPosition | null = null;
    for (;;) {
      if (signal.aborted) throw new Error('api.export aborted');
      const { last, items } = await resource.page(row.orgId, cursor, row.withNotes);
      for (const item of items) lines.push(JSON.stringify(item));
      if (lines.length > EXPORT_ROW_CAP) return fail('too_many_rows');
      if (!last || items.length < EXPORT_PAGE) break;
      cursor = { updatedAt: last.updatedAt, id: last.id };
    }

    const content = gzipSync(Buffer.from(lines.length ? `${lines.join('\n')}\n` : '', 'utf8'));
    if (content.length > EXPORT_BYTE_CAP) return fail('too_large');
    const finishedAt = new Date();
    await prisma.apiExport.updateMany({
      where: { id: row.id, orgId: row.orgId, status: 'RUNNING' },
      data: {
        status: 'READY',
        content,
        rowCount: lines.length,
        byteSize: content.length,
        finishedAt,
        expiresAt: new Date(finishedAt.getTime() + EXPORT_TTL_MS),
      },
    });
    return { rows: lines.length, bytes: content.length, skipped: 0 };
  });
}

/**
 * Whether the key behind an export may still read it: live, bound to this org,
 * holding every scope in `scopes`, and the org still entitled to the API. The
 * same questions withApiKey() asks at the door, asked again for a link.
 */
export async function keyMayRead(apiKeyId: string, orgId: string, scopes: readonly ApiScope[]): Promise<boolean> {
  const key = await prisma.apiKey.findFirst({
    where: { id: apiKeyId, orgId },
    select: { scopes: true, expiresAt: true, revokedAt: true },
  });
  if (!key || apiKeyStatus(key) !== 'active') return false;
  const held = parseScopes(key.scopes);
  if (!scopes.every((s) => held.includes(s))) return false;
  return entitled(orgId, 'INTEGRATIONS_API');
}

/** Nightly: exports past `expiresAt`, file and row. Returns how many went. */
export async function purgeExpiredExports(now: Date = new Date()): Promise<number> {
  const r = await runWithOrg(null, () => prisma.apiExport.deleteMany({ where: { expiresAt: { lt: now } } }));
  return r.count;
}
