import { NextResponse } from 'next/server';
import { platformFromSlug } from '@/lib/chat/config';
import { verifySlackSignature } from '@/lib/chat/slackSignature';
import { markChatWorkspaceRemovedByPlatform } from '@/lib/chat/workspaces';

// POST — the platform's "your app was removed" event (#1935). Slack's Events
// API: the request is authenticated by Slack's signature over the RAW body
// (SLACK_SIGNING_SECRET, ±5 minutes), never by a session — Slack has none. An
// unsigned or stale request is 401 and changes nothing.
//
// `app_uninstalled` and `tokens_revoked` switch the workspace off and clear
// its sealed tokens (markChatWorkspaceRemovedByPlatform), so no job retries a
// dead token; Slack's one-time `url_verification` handshake is answered with
// its challenge. Every other event is acknowledged and ignored — Slack retries
// anything that is not a 2xx.
//
// Teams: removal arrives as a Bot Framework `installationUpdate` activity on
// the bot's messaging endpoint, authenticated by a Microsoft-signed JWT —
// that is …/teams/messages (#3322), so the Teams path here is 404.
export async function POST(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  const platform = platformFromSlug((await params).platform);
  if (platform !== 'SLACK') return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const rawBody = await request.text();
  const ok = verifySlackSignature({
    secret: process.env.SLACK_SIGNING_SECRET,
    timestamp: request.headers.get('x-slack-request-timestamp'),
    signature: request.headers.get('x-slack-signature'),
    rawBody,
  });
  if (!ok) return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });

  let body: { type?: unknown; challenge?: unknown; team_id?: unknown; event?: { type?: unknown } };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return NextResponse.json({ challenge: body.challenge });
  }
  const eventType = body.event?.type;
  if (body.type === 'event_callback' && (eventType === 'app_uninstalled' || eventType === 'tokens_revoked') && typeof body.team_id === 'string') {
    const n = await markChatWorkspaceRemovedByPlatform('SLACK', body.team_id.slice(0, 128), `platform_${eventType}`);
    return NextResponse.json({ ok: true, updated: n });
  }
  return NextResponse.json({ ok: true, ignored: true });
}
