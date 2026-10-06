// Unit tests for the INTEGRATIONS_API grandfather rule (#1744): which stored
// keys count as a live public-API integration.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLivePublicKey } from '../../prisma/backfill-integrations-api-grandfather.mjs';

const now = new Date('2026-10-06T12:00:00Z');

test('a live candidates:read key counts', () => {
  assert.equal(isLivePublicKey({ scopes: 'candidates:read', revokedAt: null, expiresAt: null }, now), true);
  assert.equal(isLivePublicKey({ scopes: 'companies:write, candidates:read', revokedAt: null, expiresAt: '2027-01-01' }, now), true);
});

test('revoked, expired and ingest-only keys do not', () => {
  assert.equal(isLivePublicKey({ scopes: 'candidates:read', revokedAt: new Date('2026-01-01'), expiresAt: null }, now), false);
  assert.equal(isLivePublicKey({ scopes: 'candidates:read', revokedAt: null, expiresAt: '2026-10-06T11:59:59Z' }, now), false);
  assert.equal(isLivePublicKey({ scopes: 'companies:write', revokedAt: null, expiresAt: null }, now), false);
});
