import { test, expect } from '@playwright/test';
import { makeChatState, verifyChatState } from '@/lib/chat/oauthState';
import { slackSignatureFor, verifySlackSignature } from '@/lib/chat/slackSignature';

// The two signatures the chat-app install stands on (#1935), without a database.

test.beforeAll(() => {
  process.env.NEXTAUTH_SECRET ||= 'unit-test-secret-not-for-production';
});

test('the install state binds platform, org, user and ten minutes', { tag: '@smoke' }, () => {
  const t0 = 1_800_000_000_000;
  const who = { platform: 'SLACK' as const, orgId: 'org1', userId: 'u1' };
  const state = makeChatState({ ...who, nonce: 'n1' }, t0);
  expect(verifyChatState(state, who, t0 + 60_000)).toBe(true);
  expect(verifyChatState(state, { ...who, userId: 'u2' }, t0)).toBe(false);
  expect(verifyChatState(state, { ...who, orgId: 'org2' }, t0)).toBe(false);
  expect(verifyChatState(state, { ...who, platform: 'TEAMS' }, t0)).toBe(false);
  expect(verifyChatState(state, who, t0 + 10 * 60_000 + 1)).toBe(false);
  // Tampering with any field breaks the signature.
  expect(verifyChatState(state.replace('org1', 'org2'), { ...who, orgId: 'org2' }, t0)).toBe(false);
  expect(verifyChatState('garbage', who, t0)).toBe(false);
});

test("Slack's request signature: right secret, right body, fresh timestamp", { tag: '@smoke' }, () => {
  const secret = 'signing-secret';
  const body = '{"type":"event_callback"}';
  const now = 1_800_000_000;
  const ts = String(now);
  const sig = slackSignatureFor(secret, ts, body);
  expect(verifySlackSignature({ secret, timestamp: ts, signature: sig, rawBody: body, nowS: now })).toBe(true);
  expect(verifySlackSignature({ secret, timestamp: ts, signature: sig, rawBody: body + ' ', nowS: now })).toBe(false);
  expect(verifySlackSignature({ secret: 'other', timestamp: ts, signature: sig, rawBody: body, nowS: now })).toBe(false);
  expect(verifySlackSignature({ secret, timestamp: ts, signature: sig, rawBody: body, nowS: now + 301 })).toBe(false);
  expect(verifySlackSignature({ secret: undefined, timestamp: ts, signature: sig, rawBody: body, nowS: now })).toBe(false);
  expect(verifySlackSignature({ secret, timestamp: null, signature: sig, rawBody: body, nowS: now })).toBe(false);
});
