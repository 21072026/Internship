import { NextResponse } from 'next/server';
import { WEBHOOK_EVENTS } from '@/lib/webhooks';
import { API_SCOPES } from '@/lib/apiScopes';

// Minimal OpenAPI 3.1 description of the public, key-authenticated API.
// Served publicly so integrators can discover the surface and import it into
// Swagger/Postman.
export function GET() {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Internship CRM Public API',
      version: '1.0.0',
      description:
        'Read-only candidate access (Bearer API key) plus outgoing webhooks. Every key carries an explicit scope list and may carry an expiry; revoked keys are retained for audit rather than deleted.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
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
          description: 'Requires a key holding the `candidates:read` scope.',
          security: [{ apiKey: ['candidates:read'] }],
          responses: {
            '200': {
              description: 'Array of candidates',
              content: { 'application/json': { schema: { type: 'object', properties: { candidates: { type: 'array', items: { type: 'object' } } } } } },
            },
            '401': { description: 'Missing or invalid API key' },
          },
        },
      },
    },
    'x-api-key-scopes': {
      description:
        'Scopes an API key can hold, in the canonical `<resource>:<action>` shape. A key must hold at least one.',
      scopes: API_SCOPES,
    },
    'x-webhooks': {
      description: 'Outgoing webhooks are POSTed with an X-Signature (HMAC-SHA256 of the body) and X-Event header.',
      events: WEBHOOK_EVENTS,
      payload: { type: 'object', properties: { event: { type: 'string' }, data: { type: 'object' }, sentAt: { type: 'string', format: 'date-time' } } },
    },
  };
  return NextResponse.json(spec);
}
