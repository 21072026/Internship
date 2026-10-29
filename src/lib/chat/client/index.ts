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

import { ChatClientError } from '@/lib/chat/client/errors';

export { ChatClientError };

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
  /**
   * The workspace's people with the e-mail the PLATFORM verified (#1937) — the
   * input to an identity proposal. Bots, deleted and guest-less members with
   * no e-mail are left out; an address the platform did not verify is null.
   */
  listMembers(input: { token: string }): Promise<ChatMember[]>;
}

export interface ChatMember {
  externalUserId: string;
  displayName: string;
  /** Lower-cased, and only when the platform says the address is confirmed. */
  verifiedEmail: string | null;
}

const DEFAULT_CLIENTS: Record<ChatPlatform, ChatPlatformClient> = { SLACK: slackClient, TEAMS: teamsClient };
let overrides: Partial<Record<ChatPlatform, ChatPlatformClient>> = {};

/**
 * The e2e server's stand-in (CHAT_APPS_STUB_CLIENT=1, set only by
 * playwright.config.ts — never on a deployment): no network at all, so CI never
 * calls Slack or Microsoft. A token ending in `-revoke-fails` makes the revoke
 * refuse, so the spec can prove a failed revoke is recorded and still removes
 * our copy.
 */
const STUB_CLIENT: ChatPlatformClient = {
  async postMessage() {
    return { externalMessageId: 'stub-message' };
  },
  async openDm({ externalUserId }) {
    return { id: `stub-dm-${externalUserId}` };
  },
  async listMembers() {
    // The e2e server has no directory to read: proposals are exercised
    // in-process (setChatClientsForTests) where the members are the spec's.
    return [];
  },
  async revoke({ token }) {
    if (token.endsWith('-revoke-fails')) {
      throw new ChatClientError('invalid_auth');
    }
    return { revoked: true };
  },
};

export function chatClientFor(platform: ChatPlatform): ChatPlatformClient {
  if (overrides[platform]) return overrides[platform]!;
  if (process.env.CHAT_APPS_STUB_CLIENT === '1') return STUB_CLIENT;
  return DEFAULT_CLIENTS[platform];
}

/**
 * Test seam: an in-process spec swaps in a recording client. Never called by
 * the app. Pass `{}` to restore the real clients.
 */
export function setChatClientsForTests(next: Partial<Record<ChatPlatform, ChatPlatformClient>>): void {
  overrides = next;
}
