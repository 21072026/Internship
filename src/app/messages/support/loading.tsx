import { ConversationSkeleton } from '@/components/PageSkeleton';

// The support ticket screen is a chat with the team, so it gets the bubble
// shape rather than the inbox's row shape.
export default function SupportChatLoading() {
  return <ConversationSkeleton />;
}
