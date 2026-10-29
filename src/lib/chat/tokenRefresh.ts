import { prisma } from '@/lib/prisma';
import { openBotToken, openRefreshToken, sealBotToken, sealRefreshToken } from '@/lib/chat/tokens';
import { refreshSlackToken } from '@/lib/chat/client/slack';
import { ChatClientError } from '@/lib/chat/client/errors';

// The token-refresh helper the chat adapter calls before a send (#1935). A
// Slack install with token rotation hands out a bot token that expires (12h)
// plus a refresh token; trading it a minute early keeps a send from failing on
// a token that was valid when the job started. Teams bots use their own app
// credentials, so there is nothing per-workspace to refresh.
//
// A failed refresh is the workspace's lastError and a ChatClientError for the
// caller — never a thrown secret, never a log line with a token in it.

const EARLY_MS = 60_000;

export async function freshSlackBotToken(ws: {
  id: string;
  botTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
}): Promise<string | null> {
  const current = openBotToken(ws.botTokenEnc);
  if (!ws.tokenExpiresAt || ws.tokenExpiresAt.getTime() - EARLY_MS > Date.now()) return current;
  const refresh = openRefreshToken(ws.refreshTokenEnc);
  if (!refresh) return current;
  try {
    const next = await refreshSlackToken(refresh);
    await prisma.chatWorkspace.update({
      where: { id: ws.id },
      data: {
        botTokenEnc: sealBotToken(next.accessToken),
        refreshTokenEnc: next.refreshToken ? sealRefreshToken(next.refreshToken) : ws.refreshTokenEnc,
        tokenExpiresAt: next.expiresAt,
        lastError: null,
      },
    });
    return next.accessToken;
  } catch (e) {
    const code = `refresh_${e instanceof ChatClientError ? e.code : 'internal_error'}`;
    await prisma.chatWorkspace.update({ where: { id: ws.id }, data: { lastError: code } });
    throw new ChatClientError(code);
  }
}
