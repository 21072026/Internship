'use client';

import { MentorBoard } from '@/components/board/MentorBoard';

// The rep's own board (#2580): the mentor board, whose list is the caller's own
// relations (GET /api/mentorship) and whose moves only the owner may write — a
// card opens the sales lead page instead of the mentee page.
export default function SalesBoardPage() {
  return <MentorBoard detailBase="/sales/leads" />;
}
