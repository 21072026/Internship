import type { ChatPlatformClient } from '@/lib/chat/client';
import { ChatClientError } from '@/lib/chat/client/errors';

// Slack Web API, behind the ChatPlatformClient port. A fixed host — no URL
// here is ever built from input, so there is nothing for an SSRF guard to do.
// Slack answers 200 with `{ ok: false, error }` for a refusal; that error code
// ("channel_not_found", "invalid_auth", …) is what we store, nothing else.

const SLACK_API = 'https://slack.com/api';
const TIMEOUT_MS = 8_000;

async function call(method: string, token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ChatClientError('network_error');
  }
  if (!res.ok) throw new ChatClientError(`http_${res.status}`);
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || json.ok !== true) {
    const code = typeof json?.error === 'string' ? json.error.replace(/[^a-z0-9_]/gi, '').slice(0, 64) : 'unknown_error';
    throw new ChatClientError(code || 'unknown_error');
  }
  return json;
}

export const slackClient: ChatPlatformClient = {
  async postMessage({ token, target, text }) {
    const json = await call('chat.postMessage', token, { channel: target.id, text, unfurl_links: false, unfurl_media: false });
    return { externalMessageId: typeof json.ts === 'string' ? json.ts : null };
  },
  async openDm({ token, externalUserId }) {
    const json = await call('conversations.open', token, { users: externalUserId });
    const channel = json.channel as { id?: unknown } | undefined;
    if (typeof channel?.id !== 'string') throw new ChatClientError('no_dm_channel');
    return { id: channel.id };
  },
  async revoke({ token }) {
    const json = await call('auth.revoke', token, {});
    return { revoked: json.revoked === true };
  },
};
