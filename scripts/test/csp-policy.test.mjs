// The CSP builder (#1552): the enforced policy must not change while the strict
// one is only reported, and the report sanitiser must never let a query string
// or a script sample through to a log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseCspReports } from '../../src/lib/cspReport.ts';

const require = createRequire(import.meta.url);
const { buildCsp } = require('../../src/lib/cspPolicy.cjs');

const ENFORCED =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://8x8.vc https://*.tawk.to https://cdn.jsdelivr.net/emojione/; style-src 'self' 'unsafe-inline' https://*.tawk.to https://cdn.jsdelivr.net/emojione/; img-src 'self' data: blob: https://*.tawk.to https://cdn.jsdelivr.net/emojione/; font-src 'self' https://*.tawk.to; connect-src 'self' https://*.tawk.to wss://*.tawk.to; media-src 'self' https://*.tawk.to; frame-src 'self' https://meet.jit.si https://8x8.vc https://*.tawk.to; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

const scriptSrc = (policy) => policy.split('; ').find((d) => d.startsWith('script-src '));

test('the enforced policy is byte-identical to the one next.config.js built before #1552', () => {
  assert.equal(buildCsp({}), ENFORCED);
});

test('the strict policy drops unsafe-inline and unsafe-eval from script-src and reports', () => {
  const strict = buildCsp({}, { nonce: 'abc123' });
  const src = scriptSrc(strict);
  assert.match(src, /'nonce-abc123'/);
  assert.match(src, /'strict-dynamic'/);
  assert.doesNotMatch(src, /unsafe-inline|unsafe-eval/);
  assert.ok(strict.endsWith('report-uri /api/csp-report'));
  // Everything but script-src and the report endpoint is the enforced policy.
  const rest = (p) => p.split('; ').filter((d) => !d.startsWith('script-src ') && !d.startsWith('report-uri '));
  assert.deepEqual(rest(strict), rest(ENFORCED));
});

test("dev keeps 'unsafe-eval' (React's dev runtime), production does not", () => {
  assert.match(scriptSrc(buildCsp({}, { nonce: 'n', dev: true })), /'unsafe-eval'/);
  assert.doesNotMatch(scriptSrc(buildCsp({}, { nonce: 'n' })), /'unsafe-eval'/);
});

test('analytics hosts reach both policies', () => {
  const env = { NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-1' };
  for (const p of [buildCsp(env), buildCsp(env, { nonce: 'n' })]) {
    assert.match(scriptSrc(p), /https:\/\/www\.googletagmanager\.com/);
  }
});

test('a legacy report keeps only the safe fields', () => {
  const [v] = parseCspReports({
    'csp-report': {
      'document-uri': 'https://app.example/auth/reset?token=SECRET#frag',
      'violated-directive': "script-src-elem 'self'",
      'effective-directive': 'script-src-elem',
      'blocked-uri': 'inline',
      'source-file': 'https://app.example/_next/static/chunks/main.js?v=SECRET',
      'line-number': 12,
      'column-number': '4',
      'script-sample': 'alert(SECRET)',
      disposition: 'report',
    },
  });
  assert.deepEqual(v, {
    directive: 'script-src-elem',
    blocked: 'inline',
    page: '/auth/reset',
    source: 'https://app.example/_next/static/chunks/main.js',
    line: 12,
    column: 4,
    disposition: 'report',
  });
  assert.doesNotMatch(JSON.stringify(v), /SECRET|frag/);
});

test('a Reporting API batch is read, capped, and foreign entries are skipped', () => {
  const one = { type: 'csp-violation', body: { documentURL: 'https://a.example/x?y=1', effectiveDirective: 'script-src', blockedURL: 'https://evil.example/a.js?k=v' } };
  const out = parseCspReports([one, { type: 'deprecation', body: {} }, ...Array(30).fill(one)]);
  assert.equal(out.length, 19);
  assert.equal(out[0].blocked, 'https://evil.example');
  assert.equal(out[0].page, '/x');
});

test('garbage is not a report', () => {
  for (const p of [null, 'x', 42, {}, { 'csp-report': 'x' }, [1, 2]]) assert.deepEqual(parseCspReports(p), []);
  const [v] = parseCspReports({ 'csp-report': { 'violated-directive': '<img src=x>', 'blocked-uri': 'javascript:alert(1)' } });
  assert.equal(v.directive, 'unknown');
  assert.equal(v.blocked, 'javascript');
});
