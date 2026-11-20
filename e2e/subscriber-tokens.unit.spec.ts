import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { subscriberToken, subscriberTokenId } from '@/lib/subscriberTokens';

process.env.NEXTAUTH_SECRET ||= 'synthetic-subscriber-token-tests';

test('subscriber credentials reject tampering and cannot cross purposes or recipient IDs', { tag: '@smoke' }, () => {
  const id = randomUUID();
  const confirmation = subscriberToken(id, 'confirm');
  const unsubscribe = subscriberToken(id, 'unsubscribe');
  expect(subscriberTokenId(confirmation, 'confirm')).toBe(id);
  expect(subscriberTokenId(unsubscribe, 'unsubscribe')).toBe(id);
  expect(subscriberTokenId(confirmation, 'unsubscribe')).toBeNull();
  expect(subscriberTokenId(unsubscribe, 'confirm')).toBeNull();
  expect(subscriberTokenId(`${randomUUID()}.${confirmation.split('.')[1]}`, 'confirm')).toBeNull();
  expect(subscriberTokenId(confirmation.slice(0, -1) + (confirmation.endsWith('0') ? '1' : '0'), 'confirm')).toBeNull();
  for (const input of ['', 'unknown', 'x'.repeat(5000)]) expect(subscriberTokenId(input, 'confirm')).toBeNull();
});
