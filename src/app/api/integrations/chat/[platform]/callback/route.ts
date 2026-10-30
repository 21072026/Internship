import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { resolveOrgId } from '@/lib/orgScope';
import { requestOrigin } from '@/lib/servedHosts';
import { logger } from '@/lib/logger';
import { chatRedirectUri, isChatPlatformEnabled, platformFromSlug } from '@/lib/chat/config';
import { verifyChatState } from '@/lib/chat/oauthState';
import { exchangeSlackCode } from '@/lib/chat/client/slack';
import { ChatClientError } from '@/lib/chat/client/errors';
import { ChatInstallConflict, recordChatInstall } from '@/lib/chat/workspaces';
import { withRequestScope } from '@/lib/requestContext';

// GET — the platform sends the admin back here after consent (#1935).
//
// The state must verify for THIS session, THIS org and THIS platform (and be
// under ten minutes old): a callback replayed into another admin's browser, a
// Slack code presented on the Teams callback, or an install aimed at another
// tenant all land on `?chat=failed`. The code is exchanged server-side
// (Slack `oauth.v2.access`); the tokens go straight into recordChatInstall(),
// which seals them and writes the CHAT_INSTALL audit row. Nothing here logs or
// returns a token.
//
// Teams: admin consent returns `tenant` + `admin_consent=True` and no code —
// the bot authenticates with its own app credentials, so the install records
// the tenant and holds no workspace token.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  return withRequestScope(request, async () => {
    const here = requestOrigin((n) => request.headers.get(n));
    const back = (status: string) => NextResponse.redirect(new URL(`/admin/integrations?chat=${status}`, here));
    const platform = platformFromSlug((await params).platform);
    if (!platform) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const gate = await requirePermission('org.integrations.write', { request });
    if ('error' in gate) return gate.error;
    const orgId = resolveOrgId(gate.session);
    if (!orgId) return back('failed');
    if (!isChatPlatformEnabled(platform)) return back('unavailable');

    const url = new URL(request.url);
    // The admin pressed Cancel on the consent screen: not an error.
    if (url.searchParams.get('error')) return back('cancelled');
    const state = url.searchParams.get('state');
    if (!state || !verifyChatState(state, { platform, orgId, userId: gate.actor.id })) return back('failed');

    try {
      if (platform === 'SLACK') {
        const code = url.searchParams.get('code');
        const redirectUri = chatRedirectUri('SLACK');
        if (!code || !redirectUri) return back('failed');
        const install = await exchangeSlackCode(code, redirectUri);
        if (!SAFE_ID.test(install.teamId)) return back('failed');
        await recordChatInstall({
          orgId,
          platform,
          externalId: install.teamId,
          name: install.teamName,
          botToken: install.accessToken,
          refreshToken: install.refreshToken,
          tokenExpiresAt: install.expiresAt,
          scope: install.scope,
          installedById: gate.actor.id,
        });
      } else {
        const tenant = url.searchParams.get('tenant');
        if (url.searchParams.get('admin_consent') !== 'True' || !tenant || !SAFE_ID.test(tenant)) return back('failed');
        await recordChatInstall({
          orgId,
          platform,
          externalId: tenant,
          name: `Microsoft Teams (${tenant.slice(0, 8)})`,
          botToken: null,
          scope: 'bot',
          installedById: gate.actor.id,
        });
      }
      return back('connected');
    } catch (e) {
      if (e instanceof ChatInstallConflict) return back('conflict');
      logger.warning('chat install failed', { platform, code: e instanceof ChatClientError ? e.code : 'internal_error' });
      return back('failed');
    }
  });
}
