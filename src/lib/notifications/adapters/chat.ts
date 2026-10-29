import { prisma } from '@/lib/prisma';
import type { ChannelAdapter } from './types';
import { logger } from '@/lib/logger';
import { getDictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';
import { renderNotification } from '@/lib/notificationText';
import { appOriginForOrg } from '@/lib/orgLinkOrigin';
import { isChatAppsEnabled } from '@/lib/chat/config';
import { openBotToken } from '@/lib/chat/tokens';
import { freshSlackBotToken } from '@/lib/chat/tokenRefresh';
import { chatClientFor } from '@/lib/chat/client';
import { ChatClientError } from '@/lib/chat/client/errors';

// The `chat` channel of the notification router (#1939): Slack and Teams as
// ONE adapter, so nothing outside src/lib/notifications/ and src/lib/chat/
// learns that a chat platform exists.
//
//   verified ChatIdentity → its workspace → `enabled` → target (cached DM or
//   openDm) → ChatPlatformClient.postMessage() → one ChatDelivery row.
//
// THE LEDGER TELLS "COULDN'T" FROM "BROKE": no verified identity, the app
// switched off for the deployment, or the workspace disabled by its admin is a
// SKIPPED; a platform refusal is a FAILED with its short code. Either way the
// person's other channels are untouched — the router hands each channel its
// own delivery, so a disabled or broken workspace silently falls back to
// e-mail and the bell.
//
// FREE CORE. Nothing here asks a plan or an entitlement: chat delivery is a
// way to be TOLD, and being told is never paid for (docs/pricing). The guard
// test (e2e/chat-adapter.unit.spec.ts) fails if this file imports a gate.
//
// NEVER THROWS, never logs a token, never stores the card body.

export type ChatSkipReason = 'chat_apps_off' | 'no_identity' | 'workspace_disabled';

export type ChatOutcome =
  | { status: 'SENT'; deliveryId: string }
  | { status: 'SKIPPED'; reason: ChatSkipReason }
  | { status: 'FAILED'; error: string };

/**
 * Who among these users could receive chat at all: a person-confirmed
 * (verifiedAt) identity in some workspace. The router adds the `chat` channel
 * for exactly these people, so installing an app messages nobody who has not
 * linked themselves (#1939: chat is off until an identity is confirmed).
 */
export async function chatCapableUsers(userIds: readonly string[]): Promise<Set<string>> {
  if (!isChatAppsEnabled() || userIds.length === 0) return new Set();
  try {
    const rows = await prisma.chatIdentity.findMany({
      where: { userId: { in: [...userIds] }, verifiedAt: { not: null } },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  } catch (e) {
    logger.error('chat identity lookup failed', { error: String(e) });
    return new Set();
  }
}

function errorCode(e: unknown): string {
  return e instanceof ChatClientError ? e.code : 'internal_error';
}

/** The card: the same sentence the bell shows, and the link into the recipient's own product. */
async function cardText(eventKey: string, params: Record<string, string | number>, link: string, locale: Locale, orgId: string | null) {
  const sentence = renderNotification({ type: eventKey, params }, getDictionary(locale), locale);
  const origin = await appOriginForOrg(orgId);
  return `${sentence}\n${origin}${link}`;
}

export async function deliverChat(input: {
  userId: string;
  orgId: string | null;
  eventKey: string;
  params: Record<string, string | number>;
  link: string;
  locale: Locale;
}): Promise<ChatOutcome> {
  if (!isChatAppsEnabled()) return { status: 'SKIPPED', reason: 'chat_apps_off' };
  try {
    // An identity in the recipient's own org first; enabled workspaces first,
    // so a disabled one only answers when it is the only one there is.
    const identities = await prisma.chatIdentity.findMany({
      where: { userId: input.userId, verifiedAt: { not: null } },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    const ranked = identities
      .filter((i) => !input.orgId || !i.workspace.orgId || i.workspace.orgId === input.orgId)
      .sort((a, b) => Number(b.workspace.enabled) - Number(a.workspace.enabled));
    const identity = ranked[0];
    if (!identity) return { status: 'SKIPPED', reason: 'no_identity' };
    const ws = identity.workspace;

    const record = (status: 'SENT' | 'FAILED' | 'SKIPPED', target: string, extra: { error?: string; externalMessageId?: string | null } = {}) =>
      prisma.chatDelivery.create({
        data: {
          orgId: ws.orgId,
          workspaceId: ws.id,
          identityId: identity.id,
          eventKey: input.eventKey,
          target: target.slice(0, 128),
          status,
          error: extra.error ?? null,
          externalMessageId: extra.externalMessageId ?? null,
        },
        select: { id: true },
      });

    if (!ws.enabled) {
      await record('SKIPPED', identity.dmChannelId ?? identity.externalUserId, { error: 'workspace_disabled' });
      return { status: 'SKIPPED', reason: 'workspace_disabled' };
    }

    const client = chatClientFor(ws.platform);
    let token: string;
    try {
      token = (ws.platform === 'SLACK' ? await freshSlackBotToken(ws) : openBotToken(ws.botTokenEnc)) ?? '';
    } catch (e) {
      const code = errorCode(e);
      await record('FAILED', identity.externalUserId, { error: code });
      return { status: 'FAILED', error: code };
    }
    if (ws.platform === 'SLACK' && !token) {
      await record('FAILED', identity.externalUserId, { error: 'no_token' });
      await prisma.chatWorkspace.update({ where: { id: ws.id }, data: { lastError: 'no_token' } });
      return { status: 'FAILED', error: 'no_token' };
    }

    let targetId = identity.dmChannelId;
    try {
      if (!targetId) {
        const opened = await client.openDm({ token, externalUserId: identity.externalUserId, conversationRef: identity.conversationRef });
        targetId = opened.id;
        await prisma.chatIdentity.update({ where: { id: identity.id }, data: { dmChannelId: opened.id.slice(0, 128) } });
      }
      const text = await cardText(input.eventKey, input.params, input.link, input.locale, input.orgId ?? ws.orgId);
      const sent = await client.postMessage({ token, target: { id: targetId, conversationRef: identity.conversationRef }, text });
      const row = await record('SENT', targetId, { externalMessageId: sent.externalMessageId?.slice(0, 128) ?? null });
      await prisma.chatWorkspace.update({ where: { id: ws.id }, data: { lastDeliveryAt: new Date(), lastError: null } });
      return { status: 'SENT', deliveryId: row.id };
    } catch (e) {
      const code = errorCode(e);
      await record('FAILED', targetId ?? identity.externalUserId, { error: code });
      await prisma.chatWorkspace.update({ where: { id: ws.id }, data: { lastError: code } });
      return { status: 'FAILED', error: code };
    }
  } catch (e) {
    logger.error('chat delivery failed', { eventKey: input.eventKey, error: String(e) });
    return { status: 'FAILED', error: 'internal_error' };
  }
}

/** The chat channel behind the adapter port (#1711). Skips are the adapter's own (`chat_apps_off`, …). */
export const chatAdapter: ChannelAdapter = {
  id: 'chat',
  available: () => true,
  deliver: async (d) => {
    const outcome = await deliverChat({ userId: d.userId, orgId: d.orgId, eventKey: d.def.key, params: d.params, link: d.link, locale: d.locale });
    if (outcome.status === 'SENT') return { status: 'SENT' };
    return outcome.status === 'SKIPPED' ? { status: 'SKIPPED', reason: outcome.reason } : { status: 'FAILED', error: outcome.error };
  },
};
