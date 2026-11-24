import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';

export type SubscriberAction = 'confirm' | 'unsubscribe';
export const subscriberTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

// Independent purposes: a confirmation link can never withdraw consent or vice versa.
// Unsubscribe tokens deliberately have no expiry (EMAIL_DELIVERABILITY.md §2d).
export function subscriberToken(id: string, action: SubscriberAction): string {
  const signature = createHmac('sha256', requireServerSecret()).update(`subscriber:${action}:${id}`).digest('hex');
  return `${id}.${signature}`;
}
export function subscriberTokenId(token: string, action: SubscriberAction): string | null {
  if (!/^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(token)) return null;
  const id = token.split('.')[0];
  const expected = subscriberToken(id, action);
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected)) ? id : null;
}
