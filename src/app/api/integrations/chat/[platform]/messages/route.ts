import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { platformFromSlug } from '@/lib/chat/config';
import { verifyBotFrameworkRequest } from '@/lib/chat/botFrameworkAuth';
import { markChatWorkspaceRemovedByPlatform } from '@/lib/chat/workspaces';
import { withRequestScope } from '@/lib/requestContext';

// POST — the Teams bot's messaging endpoint (#3322). The Bot Framework posts
// every activity here, authenticated by its signed JWT, never by a session
// (src/lib/chat/botFrameworkAuth.ts: signature, issuer, our app id, expiry
// and the activity's own serviceUrl). Anything that does not verify is a bare
// 401 and changes nothing.
//
// One activity has an effect today: `installationUpdate` with action
// `remove` — the tenant removed the app — switches that tenant's workspace off
// and clears its tokens (markChatWorkspaceRemovedByPlatform, audited as
// CHAT_PLATFORM_UNINSTALL), so nothing keeps sending to a bot that is gone.
// Every other activity is acknowledged with 200 and ignored: the Bot
// Framework retries anything else. Slack's events have their own signed route
// (…/slack/uninstall); this path is Teams only.
const SAFE_ID = /^[A-Za-z0-9-]{1,128}$/;

export async function POST(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  return withRequestScope(request, async () => {
    if (platformFromSlug((await params).platform) !== 'TEAMS') return NextResponse.json({ error: 'Not found' }, { status: 404 });

    let activity: {
      type?: unknown;
      action?: unknown;
      serviceUrl?: unknown;
      conversation?: { tenantId?: unknown };
      channelData?: { tenant?: { id?: unknown } };
    };
    try {
      activity = await request.json();
    } catch {
      return NextResponse.json({ error: 'Bad request' }, { status: 400 });
    }
    const auth = await verifyBotFrameworkRequest({
      authorization: request.headers.get('authorization'),
      serviceUrl: typeof activity?.serviceUrl === 'string' ? activity.serviceUrl : null,
    });
    if (!auth.ok) {
      logger.warning('teams activity refused', { reason: auth.reason });
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (activity.type === 'installationUpdate' && activity.action === 'remove') {
      const tenant = activity.channelData?.tenant?.id ?? activity.conversation?.tenantId;
      if (typeof tenant === 'string' && SAFE_ID.test(tenant)) {
        const n = await markChatWorkspaceRemovedByPlatform('TEAMS', tenant, 'platform_installation_removed');
        return NextResponse.json({ ok: true, updated: n });
      }
    }
    return NextResponse.json({ ok: true, ignored: true });
  });
}
