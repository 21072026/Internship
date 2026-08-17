import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { loadAccessibleMeeting } from '@/lib/meetingAccess';
import { parseJaasMeetingLink } from '@/lib/meetingLink';
import { JAAS_HOST, JAAS_TOKEN_TTL_SECONDS, jaasConfig, signJaasToken } from '@/lib/jaas';

// GET — the JaaS token this user needs to enter this meeting's room (#1237).
//
// The room URL is public (it is emailed out, and guests join through it); what
// this endpoint adds is a *signed* identity: display name filled in, and
// moderator rights for the person who called the meeting. Without a token the
// embedded call is a five-minute demo on the public Jitsi; with one it is our
// own tenant, uncapped.
//
// The token is minted per request and never stored: it is scoped to one room,
// lives ~2h, and is only ever handed to someone who already has access to the
// meeting itself.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Signing is cheap but not free, and a token per join is the expected volume —
  // a page in a reload loop should not be able to spin the CPU.
  const limited = enforceRateLimit(request, 'meeting-call-token', { limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const { id } = await params;

  return await withTenantScope(session, async () => {
    const meeting = await loadAccessibleMeeting(session.user, id);
    // Missing and not-yours answer the same, so the id space stays opaque.
    if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const config = jaasConfig();
    if (!config) {
      // Not an error: no JaaS credentials is the normal state of local dev, CI
      // and any deployment that has not been given a tenant. The client falls
      // back to embedding the link as-is.
      return NextResponse.json({ error: 'JaaS is not configured', code: 'not-configured' }, { status: 409 });
    }

    const room = parseJaasMeetingLink(meeting.meetLink);
    // Meetings created before the switch (and any hand-typed link) still point at
    // the public instance — nothing to sign, and signing our tenant's token for
    // someone else's host would be pointless anyway. Also rejects a link that
    // carries a *different* app id than the key we hold.
    if (!room || room.appId !== config.appId) {
      return NextResponse.json({ error: 'Not a JaaS room', code: 'not-a-jaas-room' }, { status: 409 });
    }

    const jwt = signJaasToken(config, {
      room: room.room,
      user: {
        id: session.user.id,
        name: session.user.name ?? null,
        email: session.user.email ?? null,
        moderator: meeting.organizer,
      },
    });

    return NextResponse.json(
      {
        domain: JAAS_HOST,
        appId: config.appId,
        // What JitsiMeetExternalAPI wants: the tenant-prefixed room path.
        roomName: `${config.appId}/${room.room}`,
        jwt,
        expiresIn: JAAS_TOKEN_TTL_SECONDS,
      },
      // A bearer credential in a response body — never in a shared cache, and not
      // in the browser's disk cache either.
      { headers: { 'Cache-Control': 'no-store' } }
    );
  });
}
