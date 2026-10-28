import { test, expect } from '@playwright/test';
import { seal } from '@/lib/secretBox';
import { openBotToken, openRefreshToken, sealBotToken, sealRefreshToken } from '@/lib/chat/tokens';

// The chat apps' token sealing (#1934): a token round-trips through its own
// purpose and through nothing else. A bot token opened as a refresh token — or
// any other secretBox secret opened as a bot token — is null, never plaintext.

test.beforeAll(() => {
  process.env.NEXTAUTH_SECRET ||= 'unit-test-secret-not-a-real-one-0123456789';
});

test('a chat token round-trips and never opens under another purpose', { tag: '@smoke' }, () => {
  const token = 'xoxb-synthetic-test-token';
  const sealed = sealBotToken(token);
  expect(sealed).not.toContain(token);
  expect(openBotToken(sealed)).toBe(token);
  expect(openRefreshToken(sealed)).toBeNull();
  expect(openBotToken(sealRefreshToken(token))).toBeNull();
  expect(openBotToken(seal(token, 'google-calendar-token'))).toBeNull();
  expect(openBotToken(null)).toBeNull();
  expect(openBotToken('not-a-sealed-value')).toBeNull();
  // Fresh IV per seal: the same token never seals to the same string twice.
  expect(sealBotToken(token)).not.toBe(sealed);
});
