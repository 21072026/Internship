import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { jaasConfig, JAAS_APP_ID_PREFIX } from '@/lib/jaas';

// POST — event feed from the JaaS tenant (console → Webhooks). This is what
// turns the dashboard banner's guess ("assumed to run 60 minutes") into real
// information: who is actually in the room right now.
//
// Setup: in the JaaS console point a webhook at
//   https://<host>/api/webhooks/jaas?secret=<JAAS_WEBHOOK_SECRET>
// and subscribe to ROOM_CREATED, ROOM_DESTROYED, PARTICIPANT_JOINED and
// PARTICIPANT_LEFT. Unset env = endpoint answers 404, exactly as if the
// feature did not exist — local dev, CI and un-provisioned deployments.
//
// The state written here is display-only (MeetingRoomState → the banner's
// "n in the call" line). It deliberately does NOT auto-end meetings: rooms are
// created and destroyed whenever the last participant drops, including someone
// popping in early and leaving, so "room destroyed" is not "meeting over" —
// that call stays with the participants (POST /api/meetings/[id]/end).

const schema = z.object({
  eventType: z.string().min(1).max(64),
  // "vpaas-magic-cookie-…/RoomName" — which tenant room the event is about.
  fqn: z.string().max(400).optional(),
  data: z.record(z.unknown()).optional(),
});

/** Everyone currently in a room; capped so a hostile feed can't grow a row unboundedly. */
const MAX_PARTICIPANTS = 100;

function secretOk(request: Request): { ok: boolean; configured: boolean } {
  const expected = process.env.JAAS_WEBHOOK_SECRET?.trim();
  if (!expected) return { ok: false, configured: false };
  // The console offers no custom-header field on every plan, so the secret may
  // ride in the URL instead; both spellings are ours, not JaaS-defined.
  const got = request.headers.get('x-webhook-secret') || new URL(request.url).searchParams.get('secret') || '';
  try {
    return {
      ok: got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected)),
      configured: true,
    };
  } catch {
    return { ok: false, configured: true };
  }
}

// The room name out of an fqn, with the same strictness as
// parseJaasMeetingLink: only our own tenant's rooms get state rows.
function roomFromFqn(fqn: string | undefined): string | null {
  if (!fqn) return null;
  const parts = fqn.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [appId, room] = parts;
  if (!appId.startsWith(JAAS_APP_ID_PREFIX)) return null;
  // When the signing config is present, a foreign tenant's events are noise.
  const config = jaasConfig();
  if (config && appId !== config.appId) return null;
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(room)) return null;
  return room;
}

interface RoomParticipant {
  id: string;
  name: string;
}

function participantFrom(data: Record<string, unknown> | undefined): RoomParticipant | null {
  if (!data) return null;
  const id = [data.participantId, data.participantJid, data.id]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find(Boolean);
  if (!id) return null;
  const name = typeof data.name === 'string' ? data.name.trim().slice(0, 120) : '';
  return { id: id.slice(0, 200), name };
}

function asParticipants(raw: unknown): RoomParticipant[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is RoomParticipant =>
      !!p && typeof p === 'object' && typeof (p as RoomParticipant).id === 'string'
  );
}

export async function POST(request: Request) {
  const secret = secretOk(request);
  // Unconfigured = the endpoint does not exist; wrong secret = 401.
  if (!secret.configured) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!secret.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const room = roomFromFqn(parsed.data.fqn);
  // Events we don't track (recordings, dial-in, …) and foreign rooms are
  // acknowledged and dropped — a webhook that errors gets retried or disabled.
  if (!room) return NextResponse.json({ ok: true, ignored: true });

  switch (parsed.data.eventType) {
    case 'ROOM_CREATED':
      await prisma.meetingRoomState.upsert({
        where: { room },
        update: { active: true, participants: [] },
        create: { room, active: true, participants: [] },
      });
      break;
    case 'ROOM_DESTROYED':
      await prisma.meetingRoomState.upsert({
        where: { room },
        update: { active: false, participants: [] },
        create: { room, active: false, participants: [] },
      });
      break;
    case 'PARTICIPANT_JOINED': {
      const joined = participantFrom(parsed.data.data);
      if (!joined) break;
      const state = await prisma.meetingRoomState.findUnique({ where: { room }, select: { participants: true } });
      const list = asParticipants(state?.participants).filter((p) => p.id !== joined.id);
      list.push(joined);
      await prisma.meetingRoomState.upsert({
        where: { room },
        update: { active: true, participants: list.slice(-MAX_PARTICIPANTS) as unknown as Prisma.InputJsonValue },
        create: { room, active: true, participants: [joined] as unknown as Prisma.InputJsonValue },
      });
      break;
    }
    case 'PARTICIPANT_LEFT': {
      const left = participantFrom(parsed.data.data);
      if (!left) break;
      const state = await prisma.meetingRoomState.findUnique({ where: { room }, select: { participants: true } });
      if (!state) break;
      const list = asParticipants(state.participants).filter((p) => p.id !== left.id);
      await prisma.meetingRoomState.update({
        where: { room },
        data: { participants: list as unknown as Prisma.InputJsonValue },
      });
      break;
    }
    default:
      return NextResponse.json({ ok: true, ignored: true });
  }

  return NextResponse.json({ ok: true });
}
