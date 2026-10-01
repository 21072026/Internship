// The Google connect `state` (#709) now also carries the origin the flow started
// on (#2494), so a connect from the marketing host can be handed back there by
// the callback on the registered host. Pure node, no browser, no database.
//
// Playwright (not `node --test`) because it resolves the tsconfig `@/` paths —
// the same reason given in e2e/email-groups-footer.unit.spec.ts.
import { test, expect } from '@playwright/test';
import { makeState, verifyState } from '../src/lib/googleOAuthState';

process.env.NEXTAUTH_SECRET ||= 'unit-test-secret';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://marketing.bcsit-gmbh.de';

test('a state without an origin verifies exactly as before', () => {
  const s = makeState('user_1', 'nonce1', NOW);
  expect(s.split('.')).toHaveLength(4);
  expect(verifyState(s, NOW)).toEqual({ userId: 'user_1', nonce: 'nonce1', origin: null });
});

test('a state with an origin carries it back, signed', () => {
  const s = makeState('user_1', 'nonce1', NOW, ORIGIN);
  expect(s.split('.')).toHaveLength(5);
  // The origin is encoded, so its dots cannot be mistaken for field separators.
  expect(s).not.toContain('marketing.bcsit');
  expect(verifyState(s, NOW)).toEqual({ userId: 'user_1', nonce: 'nonce1', origin: ORIGIN });
});

test('the origin is covered by the signature — it cannot be swapped or added', () => {
  const s = makeState('user_1', 'nonce1', NOW, ORIGIN);
  const parts = s.split('.');
  const evil = Buffer.from('https://evil.example', 'utf8').toString('base64url');
  expect(verifyState([...parts.slice(0, 3), evil, parts[4]].join('.'), NOW)).toBeNull();

  // Grafting an origin onto a 4-part state (keeping its signature) fails too.
  const plain = makeState('user_1', 'nonce1', NOW).split('.');
  expect(verifyState([...plain.slice(0, 3), evil, plain[3]].join('.'), NOW)).toBeNull();
  // And stripping it off a 5-part one.
  expect(verifyState([...parts.slice(0, 3), parts[4]].join('.'), NOW)).toBeNull();
});

test('expiry and shape rules are unchanged', () => {
  const s = makeState('user_1', 'nonce1', NOW, ORIGIN);
  expect(verifyState(s, NOW + 11 * 60 * 1000)).toBeNull();
  expect(verifyState('a.b.c', NOW)).toBeNull();
  expect(verifyState('a.b.c.d.e.f', NOW)).toBeNull();
  expect(verifyState('', NOW)).toBeNull();
});
