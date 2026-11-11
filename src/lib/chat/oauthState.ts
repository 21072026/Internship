import { createHmac } from 'crypto';
import type { ChatPlatform } from '@prisma/client';
import { requireServerSecret } from '@/lib/serverSecret';
import { safeEqual } from '@/lib/secretBox';

/**
 * The OAuth `state` of the chat-app install (#1935), modelled on
 * googleOAuthState.ts: signed and self-describing, no storage to clean up.
 *
 * It binds FOUR things, each for a reason:
 *   - the user — a callback replayed into another admin's session is refused;
 *   - the org — an install can only land in the org that started it;
 *   - the platform — a Slack callback can never be consumed as a Teams install;
 *   - a 10-minute expiry.
 * The HMAC key is the server secret under its own domain label (`chat-oauth:`),
 * so a Google state can never verify here and vice versa.
 *
 * Format: `platform.orgId.userId.nonce.expiry.sig` (cuids and the platform
 * enum carry no dots).
 */

const TTL_MS = 10 * 60 * 1000;

function sign(payload: string): string {
  return createHmac('sha256', requireServerSecret()).update(`chat-oauth:${payload}`).digest('base64url');
}

export function makeChatState(input: { platform: ChatPlatform; orgId: string; userId: string; nonce: string }, now = Date.now()): string {
  const payload = [input.platform, input.orgId, input.userId, input.nonce, String(now + TTL_MS)].join('.');
  return `${payload}.${sign(payload)}`;
}

export function verifyChatState(
  state: string,
  expect: { platform: ChatPlatform; orgId: string; userId: string },
  now = Date.now(),
): boolean {
  const parts = state.split('.');
  if (parts.length !== 6) return false;
  const sig = parts[5];
  const payload = parts.slice(0, 5).join('.');
  if (!safeEqual(sig, sign(payload))) return false;
  const [platform, orgId, userId, nonce, expiryRaw] = parts;
  const expiry = Number(expiryRaw);
  if (!nonce || !Number.isFinite(expiry) || expiry < now) return false;
  return platform === expect.platform && orgId === expect.orgId && userId === expect.userId;
}
