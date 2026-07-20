'use client';

import { MeetingsManager } from '@/components/MeetingsManager';

// Admin meetings — same scheduler/list as the mentor page, but the role-aware
// APIs give an admin every relation and every meeting (#661).
export default function AdminMeetingsPage() {
  return <MeetingsManager />;
}
