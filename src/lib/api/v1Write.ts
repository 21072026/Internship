// The /api/v1 write floor (#1994): what every POST/PATCH on the public API does
// before and after its own few lines, decided once.
//
//   withApiKey(request, '<resource>:write', (key) =>
//     apiWrite(request, key, schema, async (body) => {
//       …one domain write through its one writer…
//       return writeOk(apiOk(data, undefined, undefined, { status: 201 }), { action, targetType, targetId });
//     }));
//
// withApiKey() (src/lib/apiKey.ts) stays the ONE door — key, scope, org
// binding, plan, quota — so the static guards that look for it
// (check-api-key-routes, check-route-auth) see every write route too. apiWrite
// adds, in this order:
//   1. the write bucket: WRITE_RATE_LIMIT per key, on top of (and tighter
//      than) the shared per-minute window every v1 call already spent
//   2. the body: JSON, at most WRITE_BODY_MAX bytes, validated by the route's
//      zod schema — a refusal is `422 validation_failed` with
//      `errors: [{ path, code, message }]`, never a flat "Validation failed"
//   3. `Idempotency-Key` (optional, ≤ 200 printable characters): the first
//      request claims it; a retry with the same body replays the stored 2xx
//      response (`Idempotent-Replayed: true`) and writes nothing; the same key
//      with a different body is `409 idempotency_key_reused`; a retry while
//      the first is still running is `409 idempotency_in_progress`
//   4. the record: every accepted (2xx) write leaves a logActivity row naming
//      the API key id — an API write is never the one path that writes silently
//
// Only successes are remembered: a refused or failed write frees its key, so a
// caller that fixes its body (or outlasts an outage) can retry with it. Domain
// events are NOT emitted here — the domain writer a route calls (e.g.
// recordStageMove) owns its events, so an API write and a UI write of the same
// thing emit the same thing.
import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import type { ZodError, ZodType } from 'zod';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { enforceRateLimit } from '@/lib/rateLimit';
import { apiError } from '@/lib/api/v1';
import type { ApiKeyContext } from '@/lib/apiKey';

/** Per key, per minute — a quarter of the read window (V1_RATE_LIMIT). */
export const WRITE_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };
export const WRITE_BODY_MAX = 64 * 1024;
/** How long a stored response is replayed; older rows are ignored, then swept. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A response larger than this is replayed with its status only. */
export const IDEMPOTENT_BODY_MAX = 32 * 1024;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

export interface WriteActivity {
  action: string;
  targetType: string;
  targetId: string;
  detail?: string;
}

const RECORDED = Symbol('v1-write-activity');
type RecordedResponse = NextResponse & { [RECORDED]?: WriteActivity };

/** Mark a successful response with the activity row it must leave. */
export function writeOk(response: NextResponse, activity: WriteActivity): NextResponse {
  (response as RecordedResponse)[RECORDED] = activity;
  return response;
}

/** A zod failure as the 422 every v1 write answers — per field, machine-readable. */
export function validationProblem(error: ZodError): NextResponse {
  const errors = error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  return apiError(422, 'validation_failed', 'The request body is invalid', undefined, { errors });
}

function bodyProblem(message: string): NextResponse {
  return apiError(422, 'validation_failed', 'The request body is invalid', undefined, {
    errors: [{ path: '', code: 'invalid_body', message }],
  });
}

export async function apiWrite<T>(
  request: Request,
  key: ApiKeyContext,
  schema: ZodType<T>,
  handler: (body: T) => Promise<NextResponse>,
): Promise<NextResponse> {
  const limited = enforceRateLimit(request, 'v1-write', { ...WRITE_RATE_LIMIT, subject: `key:${key.id}` });
  if (limited) {
    return apiError(429, 'rate_limited', 'Too many requests', 'Too many write requests. Please try again later.', {
      headers: { 'Retry-After': limited.headers.get('Retry-After') ?? '60' },
    });
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > WRITE_BODY_MAX) return bodyProblem(`must be at most ${WRITE_BODY_MAX} bytes`);
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    return bodyProblem('must be JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return validationProblem(parsed.error);

  const idemKey = request.headers.get('idempotency-key');
  if (idemKey === null) return record(request, key, await handler(parsed.data));
  if (!IDEMPOTENCY_KEY.test(idemKey)) {
    return apiError(422, 'validation_failed', 'The Idempotency-Key header is invalid', undefined, {
      errors: [{ path: 'Idempotency-Key', code: 'invalid_header', message: 'must be 1-200 printable ASCII characters' }],
    });
  }

  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname.slice(0, 191);
  const requestHash = createHash('sha256').update(`${method}\n${path}\n${raw}`).digest('hex');

  const claim = await claimIdempotencyKey(key, idemKey, method, path, requestHash);
  if (claim instanceof Response) return claim;

  let response: NextResponse;
  try {
    response = await handler(parsed.data);
  } catch (error) {
    await prisma.apiIdempotencyKey.delete({ where: { id: claim } }).catch(() => {});
    throw error;
  }
  if (response.status < 200 || response.status >= 300) {
    await prisma.apiIdempotencyKey.delete({ where: { id: claim } }).catch(() => {});
    return response;
  }
  const body = await response.clone().text();
  await prisma.apiIdempotencyKey.update({
    where: { id: claim },
    data: { responseStatus: response.status, responseBody: Buffer.byteLength(body, 'utf8') <= IDEMPOTENT_BODY_MAX ? body : null },
  });
  return record(request, key, response);
}

/** The claimed row's id, or the response to answer instead. */
async function claimIdempotencyKey(
  key: ApiKeyContext,
  idemKey: string,
  method: string,
  path: string,
  requestHash: string,
): Promise<string | NextResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // INSERT IGNORE rather than catching P2002: a replay is the normal case for
    // an idempotent API, and Prisma logs every unique violation as an error.
    const claimed = await prisma.apiIdempotencyKey.createMany({
      data: [{ orgId: key.orgId, apiKeyId: key.id, key: idemKey, method, path, requestHash }],
      skipDuplicates: true,
    });
    const existing = await prisma.apiIdempotencyKey.findUnique({
      where: { apiKeyId_key: { apiKeyId: key.id, key: idemKey } },
    });
    if (!existing) continue; // freed between the two statements — claim again
    if (claimed.count === 1 && existing.responseStatus === null && existing.requestHash === requestHash) return existing.id;
    if (existing.createdAt.getTime() < Date.now() - IDEMPOTENCY_TTL_MS) {
      // Past its window: as good as swept. Conditional, so two retries cannot both free it.
      await prisma.apiIdempotencyKey.deleteMany({ where: { id: existing.id, createdAt: existing.createdAt } });
      continue;
    }
    if (existing.requestHash !== requestHash) {
      return apiError(409, 'idempotency_key_reused', 'Idempotency-Key reused', 'This Idempotency-Key was already used with a different request.');
    }
    if (existing.responseStatus === null) {
      return apiError(409, 'idempotency_in_progress', 'Request in progress', 'A request with this Idempotency-Key is still being processed.', {
        headers: { 'Retry-After': '1' },
      });
    }
    return new NextResponse(existing.responseBody ?? null, {
      status: existing.responseStatus,
      headers: { 'Content-Type': 'application/json', 'Idempotent-Replayed': 'true' },
    });
  }
  return apiError(409, 'idempotency_in_progress', 'Request in progress', 'A request with this Idempotency-Key is still being processed.', {
    headers: { 'Retry-After': '1' },
  });
}

async function record(request: Request, key: ApiKeyContext, response: NextResponse): Promise<NextResponse> {
  if (response.status >= 200 && response.status < 300) {
    const activity = (response as RecordedResponse)[RECORDED];
    await logActivity({
      action: activity?.action ?? 'api.write',
      targetType: activity?.targetType ?? null,
      targetId: activity?.targetId ?? null,
      detail: `api key ${key.id} · ${request.method.toUpperCase()} ${new URL(request.url).pathname}${activity?.detail ? ` · ${activity.detail}` : ''}`,
      orgId: key.orgId,
      request,
    });
  }
  return response;
}

/** Nightly: idempotency rows past their window. Returns how many went. */
export async function purgeExpiredIdempotencyKeys(now: Date = new Date()): Promise<number> {
  const r = await prisma.apiIdempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - IDEMPOTENCY_TTL_MS) } } });
  return r.count;
}
