'use client';

import { GroupEventsBoard } from '@/components/events/GroupEventsBoard';

// Group sessions of the whole org (#1856): an admin publishes, manages and records attendance.
export default function AdminEventsPage() {
  return <GroupEventsBoard canCreate isAdmin />;
}
