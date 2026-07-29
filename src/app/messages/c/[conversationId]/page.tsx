'use client';

import { use } from 'react';
import { MessageThreadView } from '@/components/MessageThreadView';

// A conversation (#769/#770) — today always a 1:1 DM between project
// co-members. Same UI as a mentorship thread; only the identifier differs.
export default function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = use(params);
  return <MessageThreadView target={{ kind: 'conversation', id: conversationId }} />;
}
