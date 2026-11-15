'use client';

import { MentorBoard } from '@/components/board/MentorBoard';

// The rep's own board (#2580): the mentor board over the viewer's own sales book
// (GET /api/mentorship?surface=sales, src/lib/salesBookRule.ts — an ADMIN's too;
// the dispatcher's is the tenant's), whose moves only the owner may write — a
// card opens the sales lead page, which reads the same rule.
export default function SalesBoardPage() {
  return <MentorBoard detailBase="/sales/leads" handoff surface="sales" />;
}
