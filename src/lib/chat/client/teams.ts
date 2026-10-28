import type { ChatPlatformClient, ChatTarget } from '@/lib/chat/client';
import { ChatClientError } from '@/lib/chat/client/errors';

// Microsoft Teams through the Bot Framework connector, behind the
// ChatPlatformClient port. The bot authenticates with its OWN credentials
// (TEAMS_APP_ID / TEAMS_APP_PASSWORD, client-credentials grant), not with a
// per-workspace token — so `token` from the port is unused here, and there is
// no workspace token to revoke: uninstalling a Teams app is the tenant removing
// it, and our side deletes the installation and every conversation reference.
//
// The connector URL comes from a STORED conversation reference (`serviceUrl`),
// which Microsoft sent us. It is still only trusted on Microsoft's hosts —
// a reference is data, and a URL in data is an SSRF waiting to happen.

const TIMEOUT_MS = 8_000;
const TOKEN_URL = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
const ALLOWED_SERVICE_HOSTS = [/^smba\.trafficmanager\.net$/i, /(^|\.)botframework\.com$/i, /(^|\.)teams\.microsoft\.com$/i];

let cached: { token: string; expiresAt: number } | null = null;

async function botToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const id = process.env.TEAMS_APP_ID;
  const secret = process.env.TEAMS_APP_PASSWORD;
  if (!id || !secret) throw new ChatClientError('not_configured');
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: id,
        client_secret: secret,
        scope: 'https://api.botframework.com/.default',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ChatClientError('network_error');
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!res.ok || typeof json?.access_token !== 'string') throw new ChatClientError(`token_http_${res.status}`);
  cached = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3000) * 1000 };
  return cached.token;
}

/** The stored reference's connector URL and conversation id, or null when it is not a Microsoft one. */
export function teamsReference(ref: unknown): { serviceUrl: string; conversationId: string } | null {
  if (!ref || typeof ref !== 'object') return null;
  const r = ref as { serviceUrl?: unknown; conversation?: { id?: unknown } };
  if (typeof r.serviceUrl !== 'string' || typeof r.conversation?.id !== 'string') return null;
  let url: URL;
  try {
    url = new URL(r.serviceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !ALLOWED_SERVICE_HOSTS.some((re) => re.test(url.hostname))) return null;
  return { serviceUrl: url.origin + url.pathname.replace(/\/+$/, ''), conversationId: r.conversation.id };
}

export const teamsClient: ChatPlatformClient = {
  async postMessage({ target, text }) {
    const ref = teamsReference(target.conversationRef);
    if (!ref) throw new ChatClientError('no_conversation_ref');
    const token = await botToken();
    let res: Response;
    try {
      res = await fetch(`${ref.serviceUrl}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'message', text, textFormat: 'plain' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ChatClientError('network_error');
    }
    if (!res.ok) throw new ChatClientError(`http_${res.status}`);
    const json = (await res.json().catch(() => null)) as { id?: unknown } | null;
    return { externalMessageId: typeof json?.id === 'string' ? json.id : null };
  },
  async openDm({ conversationRef }): Promise<ChatTarget> {
    // A Teams bot may only message a person proactively once it holds a
    // conversation reference from them (the app install / first message).
    const ref = teamsReference(conversationRef);
    if (!ref) throw new ChatClientError('no_conversation_ref');
    return { id: ref.conversationId, conversationRef };
  },
  async revoke() {
    return { revoked: false, note: 'teams_has_no_workspace_token' };
  },
};
