import type { ChatMember, ChatPlatformClient, ChatTarget } from '@/lib/chat/client';
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
  async listMembers({ externalId }) {
    // Reading a tenant's directory needs the Graph `User.Read.All`
    // application permission with the tenant admin's consent — opt-in per
    // deployment (#3327). Without the flag: no proposals for Teams rather than
    // a guess at who is who.
    if (process.env.TEAMS_GRAPH_DIRECTORY_ENABLED !== '1') throw new ChatClientError('not_supported');
    return listTenantMembers(externalId);
  },
};

// ── The tenant directory (Microsoft Graph, #3327) ──────────────────────────
// Endpoints from env with the real defaults (the e2e points them at a stub).

function graphBase(): string {
  return (process.env.GRAPH_API_BASE || 'https://graph.microsoft.com').replace(/\/$/, '');
}
function loginBase(): string {
  return (process.env.TEAMS_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/$/, '');
}
const GRAPH_PAGES = 10;
const TENANT_ID = /^[A-Za-z0-9-]{1,128}$/;

async function graphToken(tenant: string): Promise<string> {
  const id = process.env.TEAMS_APP_ID;
  const secret = process.env.TEAMS_APP_PASSWORD;
  if (!id || !secret) throw new ChatClientError('not_configured');
  let res: Response;
  try {
    res = await fetch(`${loginBase()}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'https://graph.microsoft.com/.default' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ChatClientError('network_error');
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  if (!res.ok || typeof json?.access_token !== 'string') throw new ChatClientError(`graph_token_http_${res.status}`);
  return json.access_token;
}

interface GraphUser {
  id?: unknown;
  displayName?: unknown;
  mail?: unknown;
  accountEnabled?: unknown;
}

/**
 * Every enabled user of the tenant with a mailbox address. `mail` is the
 * address the TENANT manages (its admins set it), which is what we accept as
 * platform-verified; `userPrincipalName` is a sign-in name and never matched.
 * A `@odata.nextLink` is only followed on the configured Graph host — a link
 * in a response body is data, not configuration.
 */
async function listTenantMembers(tenant: string): Promise<ChatMember[]> {
  if (!TENANT_ID.test(tenant)) throw new ChatClientError('bad_tenant');
  const token = await graphToken(tenant);
  const host = new URL(graphBase()).host;
  const out: ChatMember[] = [];
  let next: string | null = `${graphBase()}/v1.0/users?$select=id,displayName,mail,accountEnabled&$top=999`;
  for (let page = 0; next && page < GRAPH_PAGES; page++) {
    let res: Response;
    try {
      res = await fetch(next, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new ChatClientError('network_error');
    }
    if (!res.ok) throw new ChatClientError(`graph_http_${res.status}`);
    const json = (await res.json().catch(() => null)) as { value?: GraphUser[]; '@odata.nextLink'?: unknown } | null;
    for (const u of json?.value ?? []) {
      if (u.accountEnabled === false || typeof u.id !== 'string') continue;
      const mail = typeof u.mail === 'string' ? u.mail.trim().toLowerCase() : '';
      if (!mail) continue;
      out.push({ externalUserId: u.id, displayName: String(u.displayName || mail).slice(0, 191), verifiedEmail: mail });
    }
    const link = json?.['@odata.nextLink'];
    next = null;
    if (typeof link === 'string') {
      try {
        if (new URL(link).host === host) next = link;
      } catch {
        next = null;
      }
    }
  }
  return out;
}

