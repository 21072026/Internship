// Self-serve tenant signup (#1749): the switch and the order of the door. The
// e2e server runs with the flag ON, so the OFF state — the production state
// until the isolation epic lands — is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selfServeSignupEnabled, SIGNUP_ORG_RATE_LIMIT } from '../../src/lib/selfServeSignup.ts';

test('the flag is ON only for exactly "true"', () => {
  assert.equal(selfServeSignupEnabled({}), false);
  for (const v of ['', 'false', '0', '1', 'TRUE', 'True', 'yes', ' true']) {
    assert.equal(selfServeSignupEnabled({ SELF_SERVE_SIGNUP: v }), false, JSON.stringify(v));
  }
  assert.equal(selfServeSignupEnabled({ SELF_SERVE_SIGNUP: 'true' }), true);
});

test('5 signups per IP per hour', () => {
  assert.deepEqual({ ...SIGNUP_ORG_RATE_LIMIT }, { limit: 5, windowMs: 3_600_000 });
});

const route = readFileSync(new URL('../../src/app/api/public/signup/org/route.ts', import.meta.url), 'utf8');
const handler = route.slice(route.indexOf('export async function POST'));

test('the flag is the first thing the handler checks, and OFF answers 503 not_enabled before any other work', () => {
  const flag = handler.indexOf('selfServeSignupEnabled()');
  assert.ok(flag > 0, 'the handler reads the flag');
  for (const later of ['enforceRateLimit(', 'request.json(', 'prisma', 'provisionOrganization(', 'emailTakenInWorld(', 'bcrypt.hash(']) {
    const at = handler.indexOf(later);
    assert.ok(at === -1 || at > flag, `${later} must come after the flag check`);
  }
  assert.match(handler.slice(flag, flag + 220), /status: 503/);
  assert.match(handler.slice(flag, flag + 220), /not_enabled/);
});

test('the rate limit runs before the body is parsed, so invalid attempts spend the bucket too', () => {
  assert.ok(handler.indexOf('enforceRateLimit(') < handler.indexOf('request.json('));
});

test('no session and no id leave the endpoint', () => {
  assert.doesNotMatch(route, /signIn\(|encode\(|getServerSession|setCookie|cookies\(\)/);
  const responses = [...handler.matchAll(/NextResponse\.json\(([^;]+)\)/g)].map((m) => m[1]);
  assert.ok(responses.length > 0);
  for (const r of responses) assert.doesNotMatch(r, /account\.id|organization\.id|userId/, r);
});

test('the organization comes from provisionOrganization() — no second creation path', () => {
  assert.match(route, /provisionOrganization\(/);
  assert.doesNotMatch(route, /organization\.create\(|slugify\(/);
  assert.doesNotMatch(route, /\$transaction\(/);
});
