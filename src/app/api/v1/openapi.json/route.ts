import { NextResponse } from 'next/server';
import { WEBHOOK_EVENTS } from '@/lib/webhooks';
import { API_SCOPES } from '@/lib/apiScopes';
import { brandProductName, hostBrandFor } from '@/lib/orgBrand';

// Minimal OpenAPI 3.1 description of the public, key-authenticated API.
// Served publicly so integrators can discover the surface and import it into
// Swagger/Postman.
//
// The title names the product of the host it was fetched from (docs/worlds.md):
<<<<<<< HEAD
// an integrator importing it from a marketing host gets a collection named
// after the marketing product.
export function GET(request: Request) {
  const world = worldForHeaders((n) => request.headers.get(n));
=======
// an integrator importing it from a product's host gets a collection named
// after that product — the host's brand (#2936), else the vertical default.
export async function GET(request: Request) {
  const brand = await hostBrandFor(request.headers.get('x-forwarded-host') ?? request.headers.get('host'));
>>>>>>> origin/main
  const spec = {
    openapi: '3.1.0',
    info: {
      title: `${brandProductName(brand)} Public API`,
      version: '1.0.0',
      description:
        'Read-only candidate access (Bearer API key) plus outgoing webhooks. Every key carries an explicit scope list and may carry an expiry; revoked keys are retained for audit rather than deleted. Scope, expiry, revocation and the key’s organisation are enforced on every request: an expired or revoked key answers 401, a key missing the operation’s scope answers 403, and every response contains only the data of the organisation the key belongs to. Limits: each key has its own window of 120 requests a minute (requests without a working key share their address\u2019s window), and a key may additionally carry a daily or monthly request allowance. Every response carries RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset (seconds) for whichever limit is closest to exhaustion; a 429 also carries Retry-After and a `type` of `rate_limited` (the per-minute window) or `quota_exceeded` (the period allowance, with `resetAt`).',
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
    },
    paths: {
      '/candidates': {
        get: {
          summary: 'List candidates (mentees)',
          description:
            'Requires a key holding the `candidates:read` scope. Returns only the candidates of the organisation the key belongs to.',
          security: [{ apiKey: ['candidates:read'] }],
          responses: {
            '200': {
              description: 'Array of candidates, scoped to the key’s organisation',
              headers: {
                'RateLimit-Limit': { $ref: '#/components/headers/RateLimitLimit' },
                'RateLimit-Remaining': { $ref: '#/components/headers/RateLimitRemaining' },
                'RateLimit-Reset': { $ref: '#/components/headers/RateLimitReset' },
              },
              content: { 'application/json': { schema: { type: 'object', properties: { candidates: { type: 'array', items: { type: 'object' } } } } } },
            },
            '401': { description: 'Missing, unknown, expired or revoked API key' },
            '403': {
              description:
                'The key does not hold the `candidates:read` scope, or is not bound to an organisation',
            },
            '429': {
              description:
                'Refused by a limit. `type: rate_limited` — the per-minute window (per key; per address for requests without a working key); `type: quota_exceeded` — the key\u2019s daily or monthly allowance is spent until `resetAt` (UTC). Both carry Retry-After.',
              headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } },
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { error: { type: 'string' }, type: { type: 'string', enum: ['rate_limited', 'quota_exceeded'] }, resetAt: { type: 'string', format: 'date-time' } },
                  },
                },
              },
            },
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
