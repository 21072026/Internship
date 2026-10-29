import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { requirePermission } from '@/lib/authz';
import { resolveOrgId } from '@/lib/orgScope';
import { requestOrigin } from '@/lib/servedHosts';
import { SLACK_BOT_SCOPES, chatRedirectUri, isChatPlatformEnabled, platformFromSlug, slackAuthorizeUrl, teamsLoginBase } from '@/lib/chat/config';
import { makeChatState } from '@/lib/chat/oauthState';

// GET — start the admin's install of the Slack / Teams app (#1935). A redirect,
// not JSON: the browser has to land on the platform's consent screen (the
// Google connect flow's shape, src/app/api/integrations/google/connect).
//
// Behind `org.integrations.write`, ON THE ROUTE: a MENTOR, MENTEE, COMPANY or
// SOURCE (or an OBSERVER) gets 403 + a denial row, whatever the UI renders.
// Enabled, not merely configured: without CHAT_APPS_ENABLED=1 and the
// platform's credentials the browser lands back on the console with
// `?chat=unavailable` instead of a thrown error.
//
// The signed state binds platform + org + user + a 10-minute expiry
// (src/lib/chat/oauthState.ts), so the callback can only finish the install
// this admin started, in this org, on this platform.
export async function GET(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  const base = requestOrigin((n) => request.headers.get(n));
  const platform = platformFromSlug((await params).platform);
  if (!platform) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = resolveOrgId(gate.session);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 });

  const redirectUri = chatRedirectUri(platform);
  if (!isChatPlatformEnabled(platform) || !redirectUri) {
    return NextResponse.redirect(new URL('/admin/integrations?chat=unavailable', base));
  }
  const state = makeChatState({ platform, orgId, userId: gate.actor.id, nonce: randomBytes(12).toString('hex') });

  if (platform === 'SLACK') {
    const url = new URL(slackAuthorizeUrl());
    url.searchParams.set('client_id', process.env.SLACK_CLIENT_ID ?? '');
    url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return NextResponse.redirect(url);
  }
  // Teams: Entra ID admin consent for the bot's application. A single-tenant
  // app consents in its own tenant; a multi-tenant one lets the admin's.
  const tenant = process.env.TEAMS_TENANT_ID || 'organizations';
  const url = new URL(`${teamsLoginBase()}/${encodeURIComponent(tenant)}/adminconsent`);
  url.searchParams.set('client_id', process.env.TEAMS_APP_ID ?? '');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return NextResponse.redirect(url);
}
