import { ListPageSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for the inbox itself. /messages is a *list* of
// conversations — one card per thread with an avatar, a preview and an unread
// badge — not a chat, so the chat-bubble shape belongs on the thread routes
// below (each has its own loading.tsx) and this one keeps the row shape.
export default function MessagesLoading() {
  return <ListPageSkeleton rows={6} />;
}
