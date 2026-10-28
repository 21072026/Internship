import type { ChatPlatform } from '@prisma/client';
import { slackClient } from '@/lib/chat/client/slack';
import { teamsClient } from '@/lib/chat/client/teams';

// THE PORT (#1939). Every HTTP call to Slack or Microsoft lives behind this
// interface and nowhere else: a route handler or a cron job that talks to a
// chat platform directly is the design gone wrong. The router's chat adapter
// (src/lib/notifications/adapters/chat.ts) and the console's uninstall are the
// only callers.
//
// Every method throws a ChatClientError on a platform refusal, with a short
// code safe to store in ChatDelivery.error / ChatWorkspace.lastError — never a
// token, never a response body.

export { ChatClientError } from '@/lib/chat/client/errors';

export interface ChatTarget {
  /** DM or channel id (Slack D…/C…, Teams conversation id). */
  id: string;
  /** Teams only: the stored conversation reference (serviceUrl + conversation). */
  conversationRef?: unknown;
}

export interface ChatPlatformClient {
  /** Post a plain-text card; returns the platform's message id. */
  postMessage(input: { token: string; target: ChatTarget; text: string }): Promise<{ externalMessageId: string | null }>;
  /** Open (or find) the bot's DM with a member; returns the target to cache. */
  openDm(input: { token: string; externalUserId: string; conversationRef?: unknown }): Promise<ChatTarget>;
  /** Revoke the installation's token on the platform's side (the real uninstall). */
  revoke(input: { token: string }): Promise<{ revoked: boolean; note?: string }>;
}

const DEFAULT_CLIENTS: Record<ChatPlatform, ChatPlatformClient> = { SLACK: slackClient, TEAMS: teamsClient };
let overrides: Partial<Record<ChatPlatform, ChatPlatformClient>> = {};

export function chatClientFor(platform: ChatPlatform): ChatPlatformClient {
  return overrides[platform] ?? DEFAULT_CLIENTS[platform];
}

/**
 * Test seam: an in-process spec swaps in a recording client. Never called by
 * the app. Pass `{}` to restore the real clients.
 */
export function setChatClientsForTests(next: Partial<Record<ChatPlatform, ChatPlatformClient>>): void {
  overrides = next;
}
