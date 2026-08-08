import { redirect } from 'next/navigation';

// The mentee portal had its own message list, built from mentorships alone: it
// missed project DMs and group chats, and showed one row per mentorship rather
// than one per person. /messages is the inbox for every role (#1156), so this
// route only forwards — old links and bookmarks keep working.
export default function PortalMessagesPage() {
  redirect('/messages');
}
