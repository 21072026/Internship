'use client';

import { use } from 'react';
import { MessageThreadView } from '@/components/MessageThreadView';

// A mentorship thread, addressed by its relation id. The thread UI itself is
// shared with the conversation route (/messages/c/[conversationId]) — see
// MessageThreadView.
export default function ThreadPage({ params }: { params: Promise<{ relationId: string }> }) {
  const { relationId } = use(params);
  return <MessageThreadView target={{ kind: 'relation', id: relationId }} />;
}
