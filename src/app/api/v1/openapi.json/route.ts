import { NextResponse } from 'next/server';
import { WEBHOOK_EVENTS } from '@/lib/webhooks';

// Minimal OpenAPI 3.1 description of the public, key-authenticated API.
// Served publicly so integrators can discover the surface and import it into
// Swagger/Postman.
export function GET() {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Internship CRM Public API',
      version: '1.0.0',
      description: 'Read-only candidate access (Bearer API key) plus outgoing webhooks.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'An admin-issued API key.' },
      },
    },
    paths: {
      '/candidates': {
        get: {
          summary: 'List candidates (mentees)',
          security: [{ apiKey: [] }],
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
    'x-webhooks': {
      description: 'Outgoing webhooks are POSTed with an X-Signature (HMAC-SHA256 of the body) and X-Event header.',
      events: WEBHOOK_EVENTS,
      payload: { type: 'object', properties: { event: { type: 'string' }, data: { type: 'object' }, sentAt: { type: 'string', format: 'date-time' } } },
    },
  };
  return NextResponse.json(spec);
}
