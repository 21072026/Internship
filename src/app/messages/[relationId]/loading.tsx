import { ConversationSkeleton } from '@/components/PageSkeleton';

// A mentorship thread: bubbles, not rows — a list skeleton here would flash the
// wrong layout before the messages arrive.
export default function ThreadLoading() {
  return <ConversationSkeleton />;
}
