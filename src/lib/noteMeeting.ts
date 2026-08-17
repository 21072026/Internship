import { canAccessMeeting } from '@/lib/meetingAccess';

// May this user attach a note to this meeting (#1056)?
//
// Without the check, any note could carry any meeting id: the note itself stays
// private, but the id is a foreign key into someone else's meeting and
// `GET /api/notes?meetingId=` would happily confirm it exists. So the rule is
// the same one that governs the meeting: you were in it, or you called it —
// which is `canAccessMeeting`, shared with the call-token endpoint (#1237).
export async function canAttachNoteToMeeting(
  user: { id: string; role: string },
  meetingId: string
): Promise<boolean> {
  return canAccessMeeting(user, meetingId);
}
