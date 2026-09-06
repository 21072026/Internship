import { ConversationSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for /messages/*. A chat, not a table — a row skeleton here
// would flash the wrong layout before the thread arrives.
export default function MessagesLoading() {
  return <ConversationSkeleton />;
}
