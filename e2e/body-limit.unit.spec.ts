import { test, expect } from '@playwright/test';
import { bodyLimitVerdict, jsonBodyLimitFor, DEFAULT_JSON_BODY_MAX_BYTES, DEFAULT_ADMIN_JSON_BODY_MAX_BYTES } from '@/lib/bodyLimitRule';

// The /api JSON body ceiling (#3210) — the rule alone, no browser. A security
// boundary (an unbounded body is a memory-exhaustion door), so @smoke.

const base = { method: 'POST', pathname: '/api/apply', contentType: 'application/json', env: {} };

test('an oversized JSON write is refused, one at the limit is not', { tag: '@smoke' }, async () => {
  expect(bodyLimitVerdict({ ...base, contentLength: String(DEFAULT_JSON_BODY_MAX_BYTES) })).toEqual({ ok: true });
  expect(bodyLimitVerdict({ ...base, contentLength: String(DEFAULT_JSON_BODY_MAX_BYTES + 1) })).toEqual({
    ok: false,
    status: 413,
    limit: DEFAULT_JSON_BODY_MAX_BYTES,
  });
  // text/plain and a missing type reach request.json() too.
  expect(bodyLimitVerdict({ ...base, contentType: 'text/plain', contentLength: '5000000' }).ok).toBe(false);
  expect(bodyLimitVerdict({ ...base, contentType: null, contentLength: '5000000' }).ok).toBe(false);
});

test('admin importers keep their headroom; uploads and reads are not judged', { tag: '@smoke' }, async () => {
  expect(jsonBodyLimitFor('/api/admin/migrate', {})).toBe(DEFAULT_ADMIN_JSON_BODY_MAX_BYTES);
  expect(bodyLimitVerdict({ ...base, pathname: '/api/admin/migrate', contentLength: String(8 * 1024 * 1024) }).ok).toBe(true);
  expect(bodyLimitVerdict({ ...base, contentType: 'multipart/form-data; boundary=x', contentLength: '9000000' }).ok).toBe(true);
  expect(bodyLimitVerdict({ ...base, method: 'GET', contentLength: '9000000' }).ok).toBe(true);
  expect(bodyLimitVerdict({ ...base, pathname: '/trust', contentLength: '9000000' }).ok).toBe(true);
});

test('a chunked body passes (the proxy owns that half); env tunes but cannot disable', { tag: '@smoke' }, async () => {
  expect(bodyLimitVerdict({ ...base, contentLength: null }).ok).toBe(true);
  expect(jsonBodyLimitFor('/api/apply', { JSON_BODY_MAX_BYTES: '2048' })).toBe(2048);
  for (const bad of ['0', '-1', 'lots', '']) {
    expect(jsonBodyLimitFor('/api/apply', { JSON_BODY_MAX_BYTES: bad })).toBe(DEFAULT_JSON_BODY_MAX_BYTES);
  }
});
