import type { ChatPlatformClient } from '@/lib/chat/client';
import { ChatClientError } from '@/lib/chat/client/errors';

// Slack Web API, behind the ChatPlatformClient port. No URL here is ever built
// from input — only from operator config — so there is nothing for an SSRF guard to do.
// Slack answers 200 with `{ ok: false, error }` for a refusal; that error code
// ("channel_not_found", "invalid_auth", …) is what we store, nothing else.

/** SLACK_API_BASE (operator config) or the real API — so the e2e can point it at its local stub. */
export function slackApiBase(): string {
  return (process.env.SLACK_API_BASE || 'https://slack.com/api').replace(/\/$/, '');
}
const TIMEOUT_MS = 8_000;

async function call(method: string, token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${slackApiBase()}/${method}`, {
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

export interface SlackInstall {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string;
  teamId: string;
  teamName: string;
}

async function oauthAccess(params: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${slackApiBase()}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ChatClientError('network_error');
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json || json.ok !== true) {
    const code = typeof json?.error === 'string' ? json.error.replace(/[^a-z0-9_]/gi, '').slice(0, 64) : `http_${res.status}`;
    throw new ChatClientError(code || 'unknown_error');
  }
  return json;
}

function installFrom(json: Record<string, unknown>): SlackInstall {
  const team = (json.team ?? {}) as { id?: unknown; name?: unknown };
  if (typeof json.access_token !== 'string' || typeof team.id !== 'string') throw new ChatClientError('malformed_install');
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
    scope: typeof json.scope === 'string' ? json.scope : '',
    teamId: team.id,
    teamName: typeof team.name === 'string' && team.name ? team.name : team.id,
  };
}

/** The install callback's code exchange (#1935). Never logs the response. */
export async function exchangeSlackCode(code: string, redirectUri: string): Promise<SlackInstall> {
  return installFrom(
    await oauthAccess({
      client_id: process.env.SLACK_CLIENT_ID ?? '',
      client_secret: process.env.SLACK_CLIENT_SECRET ?? '',
      code,
      redirect_uri: redirectUri,
    }),
  );
}

/** Token rotation: a rotating Slack install trades its refresh token before the bot token expires. */
export async function refreshSlackToken(refreshToken: string): Promise<SlackInstall> {
  return installFrom(
    await oauthAccess({
      client_id: process.env.SLACK_CLIENT_ID ?? '',
      client_secret: process.env.SLACK_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
}
