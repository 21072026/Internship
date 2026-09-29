'use client';

import { MentorBoard } from '@/components/board/MentorBoard';

// The board itself lives in components/board/MentorBoard.tsx since #2580, so the
// MARKETING sales surface renders the same one at /sales/board.
export default function MentorBoardPage() {
  return <MentorBoard />;
}
