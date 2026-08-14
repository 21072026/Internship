import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { getThreadIfAllowed } from '@/lib/messaging';
import { conversationForRelation } from '@/lib/conversations';
import { MessageThreadView } from '@/components/MessageThreadView';

// A mentorship thread, addressed by its relation id.
//
// This URL is the app's oldest way into a 1:1 chat and it is linked from
// everywhere — the mentee card, the portal, notifications, digest emails — so it
// stays, but it no longer *is* a thread: it hands over to the pair's single
// conversation (#1156). Two entry points to the same person used to mean two
// threads with half the history in each.
export default async function ThreadPage({ params }: { params: Promise<{ relationId: string }> }) {
  const { relationId } = await params;
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');

  // Same authorization as the thread API: participants and admins only. An
  // unauthorized (or unknown) relation falls through to the view below, which
  // renders the usual "not found" without leaking that the relation exists.
  const rel = await getThreadIfAllowed(session.user, relationId);
  const conversation = rel ? await conversationForRelation(rel) : null;
  if (conversation) redirect(`/messages/c/${conversation.id}`);

  return <MessageThreadView target={{ kind: 'relation', id: relationId }} />;
}
