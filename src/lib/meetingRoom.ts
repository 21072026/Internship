import { randomBytes } from 'crypto';
import { jaasConfig, jaasRoomUrl } from '@/lib/jaas';

// Where a meeting's video room comes from. Server-only (node:crypto); the
// client-side link *checks* live in @/lib/meetingLink so components can import
// them without pulling crypto into the browser bundle.
//
// This used to be three copies of the same template literal (instant meetings,
// accepted meeting requests, recurring series). They are one function now
// because the JaaS/free-instance choice below has to apply to all of them.

// The room name, without a host. Unguessable on purpose: the room is the only
// thing protecting a call on the public instance, and on JaaS it is what the
// participant's token is scoped to.
export function generateMeetingRoomName(): string {
  return `InternshipCRM-${randomBytes(8).toString('hex')}`;
}

// Hybrid routing: JaaS MAU is a metered allowance (25/month on the free tier,
// and *every* participant of a JaaS room counts), so the tenant is reserved for
// the one flow where the embedded panel matters most and the head-count is
// lowest — one-on-one calls. Everything else stays on the free public instance.
//
//   inviteeCount === 1  → JaaS room, when the tenant is configured
//                         (organizer + exactly one invitee = a 1:1 call)
//   anything else       → https://meet.jit.si/<room>
//                         (group/bulk links, and `null` for flows like
//                         recurring series whose audience is derived from
//                         membership later and can grow over time)
//
// The free fallback is not a leftover: local dev, CI and every e2e run have no
// JaaS credentials. It also means a broken/expired key never leaves the app
// unable to create a meeting — the link degrades to one that anybody can still
// open in a tab. The runtime counterpart (an existing 8x8.vc room failing) is
// handled client-side via freeMeetingFallbackLink in @/lib/meetingLink.
export function generateMeetingLink(opts: { inviteeCount: number | null }): string {
  const room = generateMeetingRoomName();
  const config = opts.inviteeCount === 1 ? jaasConfig() : null;
  return config ? jaasRoomUrl(config, room) : `https://meet.jit.si/${room}`;
}
