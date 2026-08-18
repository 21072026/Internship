import { randomBytes } from 'crypto';
import { jaasConfig, jaasRoomUrl } from '@/lib/jaas';

// Where a meeting's video room comes from. Server-only (node:crypto); the
// client-side link *checks* live in @/lib/meetingLink so components can import
// them without pulling crypto into the browser bundle.
//
// This used to be three copies of the same template literal (instant meetings,
// accepted meeting requests, recurring series). They are one function now
// because the JaaS switch below has to apply to all three — a room created on
// the public instance would still cut out after five minutes.

// The room name, without a host. Unguessable on purpose: the room is the only
// thing protecting a call on the public instance, and on JaaS it is what the
// participant's token is scoped to.
export function generateMeetingRoomName(): string {
  return `InternshipCRM-${randomBytes(8).toString('hex')}`;
}

// A JaaS room when the tenant is configured, the public Jitsi otherwise.
//
// The fallback is not a leftover: local dev, CI and every e2e run have no JaaS
// credentials, and the five-minute embed limit is irrelevant there. It also
// means a broken/expired key never leaves the app unable to create a meeting —
// the link degrades to one that anybody can still open in a tab.
export function generateMeetingLink(): string {
  const room = generateMeetingRoomName();
  const config = jaasConfig();
  return config ? jaasRoomUrl(config, room) : `https://meet.jit.si/${room}`;
}
