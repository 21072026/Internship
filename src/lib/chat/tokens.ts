import { open, seal } from '@/lib/secretBox';

// Purpose-scoped sealing for the chat apps' tokens (#1934). A dedicated purpose
// means a value sealed here can never be opened as any other secretBox secret —
// a Google refresh token, an SSO key — and vice versa: `open()` derives a
// different key per purpose and answers null on a mismatch.
//
// Server-only. Never log the plaintext or the sealed value.

export const CHAT_BOT_TOKEN_PURPOSE = 'chat-bot-token';
export const CHAT_REFRESH_TOKEN_PURPOSE = 'chat-refresh-token';

export function sealBotToken(token: string): string {
  return seal(token, CHAT_BOT_TOKEN_PURPOSE);
}

/** The bot token, or null when the value is not one sealed by sealBotToken(). */
export function openBotToken(sealed: string | null | undefined): string | null {
  return sealed ? open(sealed, CHAT_BOT_TOKEN_PURPOSE) : null;
}

export function sealRefreshToken(token: string): string {
  return seal(token, CHAT_REFRESH_TOKEN_PURPOSE);
}

export function openRefreshToken(sealed: string | null | undefined): string | null {
  return sealed ? open(sealed, CHAT_REFRESH_TOKEN_PURPOSE) : null;
}
