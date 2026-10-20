import { NextResponse } from 'next/server';
import { WEBHOOK_EVENTS } from '@/lib/webhooks';
import { API_SCOPES } from '@/lib/apiScopes';
import { brandProductName, hostBrandFor } from '@/lib/orgBrand';
import { API_ERROR_TYPES, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/lib/api/v1';

// The day the pre-#1988 `candidates` alias key is removed from GET /candidates.
const CANDIDATES_ALIAS_SUNSET = '2027-01-31';

const problem = { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } };
const listParameters = [
  { $ref: '#/components/parameters/Limit' },
  { $ref: '#/components/parameters/Cursor' },
  { $ref: '#/components/parameters/UpdatedSince' },
];
const rateLimitResponseHeaders = {
  'RateLimit-Limit': { $ref: '#/components/headers/RateLimitLimit' },
  'RateLimit-Remaining': { $ref: '#/components/headers/RateLimitRemaining' },
  'RateLimit-Reset': { $ref: '#/components/headers/RateLimitReset' },
};
const errorResponses = {
  '400': { $ref: '#/components/responses/BadRequest' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '403': { $ref: '#/components/responses/Forbidden' },
  '429': { $ref: '#/components/responses/TooManyRequests' },
};

// Minimal OpenAPI 3.1 description of the public, key-authenticated API.
// Served publicly so integrators can discover the surface and import it into
// Swagger/Postman.
//
// The title names the product of the host it was fetched from (docs/worlds.md):
// an integrator importing it from a product's host gets a collection named
// after that product — the host's brand (#2936), else the vertical default.
export async function GET(request: Request) {
  const brand = await hostBrandFor(request.headers.get('x-forwarded-host') ?? request.headers.get('host'));
  const spec = {
    openapi: '3.1.0',
    info: {
      title: `${brandProductName(brand)} Public API`,
      version: '1.0.0',
      description:
        'Read-only candidate access (Bearer API key) plus outgoing webhooks. Every list answers `{ data, page: { nextCursor, hasMore } }` and takes `limit`, `cursor` and `updatedSince`; every failure is an RFC 9457 problem document with a stable `type`. Writes need a `<resource>:write` scope, have their own tighter limit of 30 a minute per key, accept an `Idempotency-Key` and answer an invalid body with 422 and per-field `errors`. Every key carries an explicit scope list and may carry an expiry; revoked keys are retained for audit rather than deleted. Scope, expiry, revocation and the key’s organisation are enforced on every request: an expired or revoked key answers 401, a key missing the operation’s scope answers 403, and every response contains only the data of the organisation the key belongs to. Limits: each key has its own window of 120 requests a minute (requests without a working key share their address\u2019s window), and a key may additionally carry a daily or monthly request allowance. Every response carries RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset (seconds) for whichever limit is closest to exhaustion; a 429 also carries Retry-After and a `type` of `rate_limited` (the per-minute window) or `quota_exceeded` (the period allowance, with `resetAt`).',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      // On every response (#2010): the limit closest to exhaustion — the key's
      // per-minute window or its period allowance.
      headers: {
        RateLimitLimit: { description: 'Requests allowed in the current window or period.', schema: { type: 'integer' } },
        RateLimitRemaining: { description: 'Requests left in it.', schema: { type: 'integer' } },
        RateLimitReset: { description: 'Seconds until it resets.', schema: { type: 'integer' } },
        RetryAfter: { description: 'Seconds to wait before retrying (on a 429).', schema: { type: 'integer' } },
      },
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An admin-issued API key. Keys are scoped (`<resource>:<action>`), may expire, and can be revoked. Known scopes: ' +
            API_SCOPES.join(', ') + '.',
        },
      },
      // The v1 contract (#1988, src/lib/api/v1.ts) as reusable pieces: every
      // list endpoint takes the same three parameters, answers the same
      // envelope and fails with the same problem document.
      parameters: {
        Limit: {
          name: 'limit',
          in: 'query',
          description: `Page size. Default ${DEFAULT_PAGE_LIMIT}; a value above ${MAX_PAGE_LIMIT} is clamped to ${MAX_PAGE_LIMIT}, not refused.`,
          schema: { type: 'integer', minimum: 1, default: DEFAULT_PAGE_LIMIT, maximum: MAX_PAGE_LIMIT },
        },
        Cursor: {
          name: 'cursor',
          in: 'query',
          description:
            'Opaque cursor from `page.nextCursor` of the previous page. Pages walk `(updatedAt, id)` ascending, so a row changed during a walk is met again at the end rather than skipped. A cursor that was altered, or minted by another list, answers 400 `validation_failed` — never the first page.',
          schema: { type: 'string' },
        },
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          description:
            'Optional on every write (1-200 printable ASCII characters). A retry with the same key and the same request replays the stored success (with `Idempotent-Replayed: true`) and writes nothing; the same key with a different request is 409 `idempotency_key_reused`; a retry while the first is still running is 409 `idempotency_in_progress`. Only successes are remembered, for 24 hours; a refused write frees its key.',
          schema: { type: 'string', maxLength: 200 },
        },
        UpdatedSince: {
          name: 'updatedSince',
          in: 'query',
          description: 'Only rows changed at or after this instant (ISO-8601 date-time with a zone, e.g. `2026-10-01T00:00:00Z`). Combine with `cursor` for an incremental sync.',
          schema: { type: 'string', format: 'date-time' },
        },
      },
      schemas: {
        PageInfo: {
          type: 'object',
          required: ['nextCursor', 'hasMore'],
          properties: {
            nextCursor: { type: ['string', 'null'], description: 'Pass as `cursor` to fetch the next page; null on the last page.' },
            hasMore: { type: 'boolean' },
          },
        },
        Problem: {
          type: 'object',
          description: 'RFC 9457 problem document (`application/problem+json`). Switch on `type`, a stable slug; `title` and `detail` are human-readable and may be reworded. `error` repeats the message for clients written before the v1 contract.',
          required: ['type', 'title', 'status'],
          properties: {
            type: { type: 'string', enum: [...API_ERROR_TYPES] },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            error: { type: 'string', deprecated: true },
            errors: {
              type: 'array',
              description: 'On a 422 `validation_failed`: one entry per invalid body field.',
              items: { type: 'object', required: ['path', 'code', 'message'], properties: { path: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } } },
            },
            fields: {
              type: 'array',
              description: 'On `validation_failed`: one entry per offending parameter or field.',
              items: { type: 'object', required: ['field', 'message'], properties: { field: { type: 'string' }, message: { type: 'string' } } },
            },
            resetAt: { type: 'string', format: 'date-time', description: 'On `quota_exceeded`: when the allowance resets (UTC).' },
          },
        },
        Candidate: {
          type: 'object',
          required: ['id', 'fullName', 'stage', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'string' },
            fullName: { type: ['string', 'null'] },
            university: { type: ['string', 'null'] },
            department: { type: ['string', 'null'] },
            graduationYear: { type: ['integer', 'null'] },
            skills: { description: 'Skill list as stored (JSON).' },
            stage: { type: ['string', 'null'], description: 'Pipeline stage of the active relationship, if any.' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
      responses: {
        UnprocessableEntity: {
          description: '`validation_failed` — the write body is invalid; `errors` names each field (`path`, `code`, `message`).',
          content: problem,
        },
        Conflict: {
          description: '`idempotency_key_reused` — the Idempotency-Key was used with a different request; `idempotency_in_progress` — a request with it is still running (Retry-After).',
          content: problem,
        },
        BadRequest: { description: '`validation_failed` — a parameter is malformed (see `fields`).', content: problem },
        Unauthorized: { description: '`invalid_api_key` — missing, unknown, expired or revoked API key.', content: problem },
        Forbidden: {
          description: '`insufficient_scope` — the key lacks the operation’s scope; `org_unbound` — the key is not bound to an organisation; `feature_locked` — the organisation’s plan does not include API access.',
          content: problem,
        },
        TooManyRequests: {
          description:
            'Refused by a limit. `type: rate_limited` — the per-minute window (per key; per address for requests without a working key); `type: quota_exceeded` — the key’s daily or monthly allowance is spent until `resetAt` (UTC). Both carry Retry-After.',
          headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } },
          content: problem,
        },
      },
    },
    paths: {
      '/candidates': {
        get: {
          summary: 'List candidates (mentees)',
          description:
            'Requires a key holding the `candidates:read` scope. Returns only the candidates of the organisation the key belongs to, one page at a time. The `candidates` key repeats `data` for clients written before the v1 envelope; it is deprecated and will be removed on ' +
            CANDIDATES_ALIAS_SUNSET + '.',
          security: [{ apiKey: ['candidates:read'] }],
          parameters: listParameters,
          responses: {
            '200': {
              description: 'One page of candidates, scoped to the key’s organisation',
              headers: rateLimitResponseHeaders,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['data', 'page'],
                    properties: {
                      data: { type: 'array', items: { $ref: '#/components/schemas/Candidate' } },
                      page: { $ref: '#/components/schemas/PageInfo' },
                      candidates: { type: 'array', items: { $ref: '#/components/schemas/Candidate' }, deprecated: true },
                    },
                  },
                },
              },
            },
            ...errorResponses,
          },
        },
      },
    },
    'x-api-key-scopes': {
      description:
        'Scopes an API key can hold, in the canonical `<resource>:<action>` shape. A key must hold at least one. Each operation names the scope it requires under `security`; a key presenting without it is refused with 403 rather than served a filtered result.',
      scopes: API_SCOPES,
    },
    'x-webhooks': {
      description: 'Outgoing webhooks are POSTed with an X-Signature (HMAC-SHA256 of the body) and X-Event header.',
      events: WEBHOOK_EVENTS,
      payload: { type: 'object', properties: { event: { type: 'string' }, data: { type: 'object' }, sentAt: { type: 'string', format: 'date-time' } } },
    },
  };
  return NextResponse.json(spec, { headers: { Vary: 'X-Forwarded-Host, Host' } });
}
