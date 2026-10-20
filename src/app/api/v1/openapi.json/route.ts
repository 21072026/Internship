import { NextResponse } from 'next/server';
import { MAX_HOOKS_PER_KEY, WEBHOOK_EVENTS } from '@/lib/webhooks';
import { API_SCOPES } from '@/lib/apiScopes';
import { brandProductName, hostBrandFor } from '@/lib/orgBrand';
import { API_ERROR_TYPES, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/lib/api/v1';
import { REQUISITION_STATUSES } from '@/lib/requisitions';

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

const str = { type: 'string' };
const nstr = { type: ['string', 'null'] };
const when = { type: 'string', format: 'date-time' };
const nwhen = { type: ['string', 'null'], format: 'date-time' };
const eqFilter = (name: string, description: string, values?: readonly string[]) => ({
  name,
  in: 'query',
  description,
  schema: values ? { type: 'string', enum: [...values] } : { type: 'string' },
});

// One list path and one single-read path per resource (#1990): the same
// envelope, parameters and error responses everywhere, a real schema per item.
function listPath(scope: string, schema: string, summary: string, description: string, filters: object[] = []) {
  return {
    get: {
      summary,
      description: `Requires a key holding \`${scope}\`. ${description} Only the rows of the key’s organisation.`,
      security: [{ apiKey: [scope] }],
      parameters: [...listParameters, ...filters],
      responses: {
        '200': {
          description: 'One page',
          headers: rateLimitResponseHeaders,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['data', 'page'],
                properties: { data: { type: 'array', items: { $ref: `#/components/schemas/${schema}` } }, page: { $ref: '#/components/schemas/PageInfo' } },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  };
}
// A write operation (#1994/#1996): the Idempotency-Key, the 422 body contract,
// the idempotency 409 and the operation's own domain 409, documented the same
// way on every write.
function writeOp(scope: string, summary: string, description: string, body: object, schema: string, status: '200' | '201', conflict: string, extraParams: object[] = []) {
  return {
    summary,
    description: `Requires a key holding \`${scope}\`. ${description}`,
    security: [{ apiKey: [scope] }],
    parameters: [...extraParams, { $ref: '#/components/parameters/IdempotencyKey' }],
    requestBody: { required: true, content: { 'application/json': { schema: body } } },
    responses: {
      [status]: {
        description: status === '201' ? 'Created' : 'Updated',
        headers: rateLimitResponseHeaders,
        content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { $ref: `#/components/schemas/${schema}` } } } } },
      },
      '404': { $ref: '#/components/responses/NotFound' },
      '409': { description: `${conflict} Or \`idempotency_key_reused\` / \`idempotency_in_progress\`.`, content: problem },
      '422': { $ref: '#/components/responses/UnprocessableEntity' },
      ...errorResponses,
    },
  };
}
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const profileProps = {
  fullName: { type: 'string', maxLength: 191 },
  university: { type: 'string', maxLength: 191 },
  department: { type: 'string', maxLength: 191 },
  graduationYear: { type: 'integer', minimum: 1950, maximum: 2100 },
  skills: { type: 'array', items: { type: 'string' }, description: 'At most 40 skills of 60 characters; a longer list is refused, not truncated.' },
};

function itemPath(scope: string, schema: string, summary: string) {
  return {
    get: {
      summary,
      description: `Requires a key holding \`${scope}\`. The same object as one element of the list. An id of another organisation answers 404, exactly like a missing one.`,
      security: [{ apiKey: [scope] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'The resource',
          headers: rateLimitResponseHeaders,
          content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { $ref: `#/components/schemas/${schema}` } } } } },
        },
        '404': { $ref: '#/components/responses/NotFound' },
        ...errorResponses,
      },
    },
  };
}

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
        'Read access to candidates, relationships, interactions, meetings, companies and the hiring resources (Bearer API key) plus outgoing webhooks. No resource carries an e-mail address or phone number; an interaction’s note body needs its own scope. Every list answers `{ data, page: { nextCursor, hasMore } }` and takes `limit`, `cursor` and `updatedSince`; every failure is an RFC 9457 problem document with a stable `type`. Writes need a `<resource>:write` scope, have their own tighter limit of 30 a minute per key, accept an `Idempotency-Key` and answer an invalid body with 422 and per-field `errors`. Every key carries an explicit scope list and may carry an expiry; revoked keys are retained for audit rather than deleted. Scope, expiry, revocation and the key’s organisation are enforced on every request: an expired or revoked key answers 401, a key missing the operation’s scope answers 403, and every response contains only the data of the organisation the key belongs to. Limits: each key has its own window of 120 requests a minute (requests without a working key share their address\u2019s window), and a key may additionally carry a daily or monthly request allowance. Every response carries RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset (seconds) for whichever limit is closest to exhaustion; a 429 also carries Retry-After and a `type` of `rate_limited` (the per-minute window) or `quota_exceeded` (the period allowance, with `resetAt`).',
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
        Relationship: {
          type: 'object',
          required: ['id', 'mentorId', 'menteeId', 'status', 'pipelineStatus', 'updatedAt'],
          properties: {
            id: str, mentorId: str, menteeId: str, companyId: nstr,
            status: { type: 'string', enum: ['ACTIVE', 'COMPLETED'] },
            pipelineStatus: { type: 'string', description: 'The pipeline stage key (organisation-specific stages are possible).' },
            startDate: when, completedAt: nwhen, updatedAt: when,
          },
        },
        Interaction: {
          type: 'object',
          required: ['id', 'relationId', 'type', 'date', 'updatedAt'],
          properties: {
            id: str, relationId: str,
            type: { type: 'string', enum: ['Meeting', 'Feedback', 'Email', 'Call', 'WhatsApp'] },
            date: when, meetingId: nstr, updatedAt: when,
            notes: { type: 'string', description: 'The note body. Present ONLY for a key that also holds `interactions:read_notes`.' },
          },
        },
        Meeting: {
          type: 'object',
          required: ['id', 'title', 'status', 'participantIds', 'updatedAt'],
          properties: {
            id: str, title: str, scheduledAt: nwhen, durationMinutes: { type: ['integer', 'null'] },
            status: { type: 'string', enum: ['SCHEDULED', 'CANCELLED'] },
            relationId: nstr, projectId: nstr,
            participantIds: { type: 'array', items: str, description: 'Account ids: the organiser and, for a relationship meeting, its mentor and mentee.' },
            guestCount: { type: 'integer', description: 'External guests without an account (never named).' },
            endedAt: nwhen, cancelledAt: nwhen, createdAt: when, updatedAt: when,
          },
        },
        Company: {
          type: 'object',
          required: ['id', 'name', 'openRequisitionCount', 'updatedAt'],
          properties: {
            id: str, name: str, country: nstr, industry: nstr, size: nstr,
            openRequisitionCount: { type: 'integer' }, createdAt: when, updatedAt: when,
          },
        },
        Requisition: {
          type: 'object',
          required: ['id', 'companyId', 'title', 'status', 'openings', 'filled', 'updatedAt'],
          properties: {
            id: str, companyId: str, title: str,
            status: { type: 'string', enum: [...REQUISITION_STATUSES] },
            city: nstr, openings: { type: 'integer' }, filled: { type: 'integer' },
            requiredSkills: { type: 'array', items: str }, closedAt: nwhen, createdAt: when, updatedAt: when,
          },
        },
        Offer: {
          type: 'object',
          description: 'An offer’s status and dates. Compensation is never part of the public API.',
          required: ['id', 'relationId', 'status', 'updatedAt'],
          properties: {
            id: str, relationId: str, requisitionId: nstr, companyId: nstr, status: str,
            startDate: nwhen, expiresAt: nwhen, sentAt: nwhen, decidedAt: nwhen, declineReasonCode: nstr,
            createdAt: when, updatedAt: when,
          },
        },
        Hook: {
          type: 'object',
          description: 'A webhook subscription owned by the calling key.',
          required: ['id', 'targetUrl', 'event', 'events', 'active', 'createdAt'],
          properties: {
            id: str, targetUrl: str, event: { type: ['string', 'null'] },
            events: { type: 'array', items: { type: 'string', enum: [...WEBHOOK_EVENTS] } },
            active: { type: 'boolean' }, createdAt: when,
          },
        },
        Me: {
          type: 'object',
          description: 'What the presented key implies — and nothing else: no user, no candidate data.',
          required: ['keyId', 'orgId', 'scopes', 'rateLimit'],
          properties: {
            keyId: str, orgId: str, orgName: nstr,
            scopes: { type: 'array', items: str },
            expiresAt: nwhen,
            rateLimit: { type: 'object', properties: { limit: { type: 'integer' }, remaining: { type: 'integer' }, resetAt: when } },
            quota: { type: ['object', 'null'], properties: { period: { type: 'string', enum: ['day', 'month'] }, limit: { type: 'integer' } } },
          },
        },
        InterviewRequest: {
          type: 'object',
          required: ['id', 'requisitionId', 'menteeId', 'companyId', 'status', 'updatedAt'],
          properties: {
            id: str, requisitionId: str, menteeId: str, companyId: str, status: str,
            scheduledAt: nwhen, meetingId: nstr, decidedAt: nwhen, cancelledAt: nwhen, createdAt: when, updatedAt: when,
          },
        },
      },
      responses: {
        NotFound: { description: '`not_found` — no such resource in the key’s organisation.', content: problem },
        UnprocessableEntity: {
          description: '`validation_failed` — the write body is invalid; `errors` names each field (`path`, `code`, `message`).',
          content: problem,
        },
        Conflict: {
          description: '`limit_reached` — a per-key cap (subscriptions); `idempotency_key_reused` — the Idempotency-Key was used with a different request; `idempotency_in_progress` — a request with it is still running (Retry-After).',
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
        post: writeOp(
          'candidates:write',
          'Create a candidate',
          'Creates a candidate in the key\u2019s organisation. Never a near-duplicate: an e-mail address already in use is always 409 `duplicate_candidate` (`matches` carries the id only when it is in your organisation); a look-alike by name, phone or university is 409 with `matches` unless `allowPossibleDuplicate` is true. The account is claimed by the person through a password reset.',
          {
            type: 'object',
            additionalProperties: false,
            required: ['fullName', 'email'],
            properties: { ...profileProps, email: { type: 'string', format: 'email', maxLength: 191 }, allowPossibleDuplicate: { type: 'boolean' } },
          },
          'Candidate',
          '201',
          '`duplicate_candidate` — with `matches: [{ id, signals, score? }]`.',
        ),
      },
      '/candidates/{id}': {
        ...itemPath('candidates:read', 'Candidate', 'Get a candidate'),
        patch: writeOp(
          'candidates:write',
          'Update a candidate',
          'Only the profile fields the read endpoint exposes. Any other key (`role`, `orgId`, `email`, credentials …) is refused with 422 `unrecognized_keys`, never ignored. A blank value is no opinion: a PATCH cannot empty a field.',
          { type: 'object', additionalProperties: false, minProperties: 1, properties: profileProps },
          'Candidate',
          '200',
          'Not used.',
          [idParam],
        ),
      },
      '/relationships/{id}/stage': {
        patch: writeOp(
          'relationships:write',
          'Move a relationship’s pipeline stage',
          'The same write path as the board: history row, notification, `pipeline.stage_change` webhook and stage SLA. `stage` is a stage KEY of the organisation (422 `unknown_stage` otherwise); a move into an off-path stage needs `reasonCode` (and `reasonNote` for OTHER). The stage it already has answers 200 with `changed: false`.',
          {
            type: 'object',
            additionalProperties: false,
            required: ['stage'],
            properties: { stage: { type: 'string', maxLength: 60 }, reasonCode: { type: 'string', maxLength: 40 }, reasonNote: { type: 'string', maxLength: 2000 } },
          },
          'Relationship',
          '200',
          '`invalid_transition` — the relationship is not ACTIVE (`currentStage` in the body); `stage_conflict` — the stage changed meanwhile (`currentStage`).',
          [idParam],
        ),
      },
      '/me': {
        get: {
          summary: 'Who am I (connector auth test)',
          description: 'Any live key may call this: it answers the key\u2019s organisation, scopes, expiry and limits — no user or candidate data. Use it to validate a credential instead of reading real data.',
          security: [{ apiKey: [] }],
          responses: {
            '200': {
              description: 'The key',
              headers: rateLimitResponseHeaders,
              content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/Me' } } } } },
            },
            ...errorResponses,
          },
        },
      },
      '/hooks': {
        get: {
          summary: 'List this key\u2019s subscriptions',
          description: 'Requires `hooks:write`. Only the subscriptions the calling key made — never another key\u2019s or an admin-created one. Secrets are never listed.',
          security: [{ apiKey: ['hooks:write'] }],
          responses: {
            '200': {
              description: 'The subscriptions',
              headers: rateLimitResponseHeaders,
              content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Hook' } } } } } },
            },
            ...errorResponses,
          },
        },
        post: {
          summary: 'Subscribe (REST hook)',
          description:
            'Requires `hooks:write`. The platform subscribes itself: send `{ targetUrl, event }` when the user turns the automation on, keep the returned `id`, and DELETE it when they turn it off. `targetUrl` must be a public https URL (private, loopback and metadata addresses are refused, 422 `unreachable_target`). The `secret` is returned once: every delivery is POSTed with `X-Event` and `X-Signature` (HMAC-SHA256 of the body with that secret). A key holds at most ' +
            MAX_HOOKS_PER_KEY +
            ' subscriptions (409 `limit_reached`). Deliveries stop when the key is revoked or expires.',
          security: [{ apiKey: ['hooks:write'] }],
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['targetUrl', 'event'],
                  properties: { targetUrl: { type: 'string', format: 'uri' }, event: { type: 'string', enum: [...WEBHOOK_EVENTS] } },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Subscribed; `secret` is shown only now',
              headers: rateLimitResponseHeaders,
              content: {
                'application/json': {
                  schema: { type: 'object', required: ['data'], properties: { data: { allOf: [{ $ref: '#/components/schemas/Hook' }, { type: 'object', required: ['secret'], properties: { secret: str } }] } } },
                },
              },
            },
            '409': { $ref: '#/components/responses/Conflict' },
            '422': { $ref: '#/components/responses/UnprocessableEntity' },
            ...errorResponses,
          },
        },
      },
      '/hooks/{id}': {
        delete: {
          summary: 'Unsubscribe',
          description: 'Requires `hooks:write`. Deletes a subscription the calling key owns. Any other id — another key\u2019s, an admin-created one, another organisation\u2019s — is 404, exactly like a missing one.',
          security: [{ apiKey: ['hooks:write'] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { $ref: '#/components/parameters/IdempotencyKey' }],
          responses: {
            '200': { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { id: str, deleted: { type: 'boolean' } } } } } } } },
            '404': { $ref: '#/components/responses/NotFound' },
            ...errorResponses,
          },
        },
      },
      '/relationships': listPath('relationships:read', 'Relationship', 'List relationships', 'Mentor ↔ mentee relationships with their pipeline stage.', [
        eqFilter('status', 'Only relationships in this status.', ['ACTIVE', 'COMPLETED']),
        eqFilter('stage', 'Only relationships at this pipeline stage key.'),
        eqFilter('mentorId', 'Only this mentor’s relationships.'),
        eqFilter('companyId', 'Only relationships placed with this company.'),
      ]),
      '/relationships/{id}': itemPath('relationships:read', 'Relationship', 'Get a relationship'),
      '/interactions': {
        ...listPath('interactions:read', 'Interaction', 'List interactions', 'Logged interactions per relationship. The note body is included only when the key also holds `interactions:read_notes`.', [
          eqFilter('relationId', 'Only this relationship’s interactions.'),
        ]),
        post: writeOp(
          'interactions:write',
          'Log an interaction',
          'The same write path as the app: one `interaction.logged` webhook and the mentee\u2019s notification. The response includes `notes` only for a key that also holds `interactions:read_notes`.',
          {
            type: 'object',
            additionalProperties: false,
            required: ['relationId', 'type', 'date', 'notes'],
            properties: {
              relationId: { type: 'string' },
              type: { type: 'string', enum: ['Meeting', 'Feedback', 'Email', 'Call', 'WhatsApp'] },
              date: { type: 'string', format: 'date-time' },
              subject: { type: 'string', maxLength: 191 },
              notes: { type: 'string', maxLength: 5000 },
            },
          },
          'Interaction',
          '201',
          'Not used.',
        ),
      },
      '/interactions/{id}': itemPath('interactions:read', 'Interaction', 'Get an interaction'),
      '/meetings': listPath('meetings:read', 'Meeting', 'List meetings', 'Meetings of a relationship or a project.'),
      '/meetings/{id}': itemPath('meetings:read', 'Meeting', 'Get a meeting'),
      '/companies': listPath('companies:read', 'Company', 'List companies', 'Companies with their count of open requisitions. No contact details.'),
      '/companies/{id}': itemPath('companies:read', 'Company', 'Get a company'),
      '/requisitions': listPath('hiring:read', 'Requisition', 'List requisitions', 'Open roles and their fill state.', [
        eqFilter('status', 'Only requisitions in this status.', REQUISITION_STATUSES),
        eqFilter('companyId', 'Only this company’s requisitions.'),
      ]),
      '/requisitions/{id}': itemPath('hiring:read', 'Requisition', 'Get a requisition'),
      '/offers': listPath('hiring:read', 'Offer', 'List offers', 'Offer status and dates (no compensation).', [
        eqFilter('relationId', 'Only offers on this relationship.'),
        eqFilter('companyId', 'Only this company’s offers.'),
      ]),
      '/offers/{id}': itemPath('hiring:read', 'Offer', 'Get an offer'),
      '/interview-requests': listPath('hiring:read', 'InterviewRequest', 'List interview requests', 'Interview requests a company made for a candidate.', [
        eqFilter('requisitionId', 'Only requests for this requisition.'),
        eqFilter('companyId', 'Only this company’s requests.'),
      ]),
      '/interview-requests/{id}': itemPath('hiring:read', 'InterviewRequest', 'Get an interview request'),
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
