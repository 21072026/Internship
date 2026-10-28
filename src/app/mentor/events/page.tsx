'use client';

import { GroupEventsBoard } from '@/components/events/GroupEventsBoard';

// A mentor's office hours (#1856): they host their own, and register for the org's mentor sessions.
export default function MentorEventsPage() {
  return <GroupEventsBoard canCreate />;
}
