// Client-safe half of the external-guest rules (#1430).
//
// The cap is enforced on the server (src/lib/meetingGuests.ts) but has to be
// shown in the form, and that module imports prisma and the mail service — so
// importing it from a client component would drag both into the browser bundle.
// Same split as @/lib/meetingLink vs @/lib/meetingRoom.

// How many outsiders one meeting may carry. Not a product limit so much as a
// blast radius: an authenticated user can otherwise turn "schedule a meeting"
// into a mailer for an arbitrary list. Well above any real meeting.
export const MAX_GUESTS_PER_MEETING = 20;
