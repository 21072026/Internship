import { NextResponse } from 'next/server';
import { platformFromSlug } from '@/lib/chat/config';
import { withRequestScope } from '@/lib/requestContext';
import { slackInteraction, teamsInteraction } from '@/lib/chat/interactions/http';

// POST — the ONE public entry point for chat buttons (#1948). No session:
// the platform's signature is the credential, and the person is re-derived
// from a confirmed ChatIdentity on every request (src/lib/chat/interactions/).
// The order of checks and why every refusal looks the same is in http.ts.
// Teams also delivers Universal Actions to the bot's messaging endpoint
// (…/teams/messages), which hands them to the same function.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  return withRequestScope(request, async () => {
    const platform = platformFromSlug((await params).platform);
    if (platform === 'SLACK') return slackInteraction(request);
    if (platform === 'TEAMS') return teamsInteraction(request);
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  });
}
