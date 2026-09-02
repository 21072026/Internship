import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { rateLimit } from '@/lib/rateLimit';
import { getThreadIfAllowed, otherParticipant } from '@/lib/messaging';
import {
  getConversationIfAllowed,
  otherConversationParticipants,
  canPostToConversation,
} from '@/lib/conversations';
import { publishRealtime } from '@/lib/realtimeBus';
import { withTenantScope } from '@/lib/orgContext';

/**
 * "X is typing…" (#1871) — the one endpoint the typing indicator needs.
 *
 * It is a publisher and nothing else: it writes no row, sends no mail, logs no
 * activity and touches no counter. That is the whole design constraint — a
 * typing indicator is worth a fan-out over the existing in-process bus
 * (`src/lib/realtimeBus.ts`) and worth nothing at all in the database, where it
 * would be a write per keystroke burst for a fact that is stale in three
 * seconds.
 *
 * It is still an authenticated write endpoint, so it carries the two guards
 * every write here carries: a rate limit (per *user*, see the note on the
 * handler — the composer throttles itself to one call every ~3s, so the ceiling
 * only bites a client that stopped asking politely), and the *same* participant
 * authorization as `POST /api/messages` —
 * `getThreadIfAllowed` / `getConversationIfAllowed`, plus the live posting check
 * for a conversation. Without that last one this would happily answer "is the
 * caller a participant of thread <id>?" for any id a signed-in user cared to
 * try.
 */

// The bus is a Node-process singleton; nothing here may be statically evaluated
// or run on the edge (same reasoning as the stream route).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const schema = z
  .object({
    relationId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
  })
  .refine((d) => Boolean(d.relationId) || Boolean(d.conversationId), {
    message: 'relationId or conversationId required',
  });

// POST — announce that the caller is composing in a thread they participate in.
// Publishes one ephemeral `typing` event to the other participants and returns.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Rate-limited **per user**, not per IP — deliberately unlike the rest of the
  // routes here, which use `enforceRateLimit` (an IP bucket). A whole cohort
  // typically sits behind one NAT egress address, so an IP ceiling anywhere near
  // the real per-user rate (the 3s client throttle allows ~20/min per open
  // thread) would be tripped by four people chatting at once — and because the
  // composer swallows the failure, the indicator would just silently stop
  // working for everyone at that location while `ratelimit.exceeded` warnings
  // (#864) piled up from entirely ordinary use. 120/min is ~6 open threads of
  // honest typing for one account, and still stops a script from using this as
  // a free fan-out amplifier.
  const limited = rateLimit(`realtime-typing:${session.user.id}`, { limit: 120, windowMs: 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } }
    );
  }

  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const { relationId = '', conversationId = '' } = parsed.data;

    // Same two-layer authorization as the message POST; both paths fail closed.
    const rel = relationId ? await getThreadIfAllowed(session.user, relationId) : null;
    const conversation = conversationId ? await getConversationIfAllowed(session.user, conversationId) : null;
    if (!rel && !conversation) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    // A read-only participant (removed from the shared project, #770) has no
    // business announcing a reply they cannot post.
    if (conversation && !(await canPostToConversation(session.user, conversation))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // The others only — never the sender's own tabs, which would otherwise show
    // them their own indicator.
    const recipients = (
      rel ? [otherParticipant(rel, session.user.id)] : await otherConversationParticipants(conversation!, session.user.id)
    ).filter((id): id is string => Boolean(id) && id !== session.user.id);

    publishRealtime(recipients, {
      type: 'typing',
      conversationId: conversation?.id ?? null,
      relationId: rel?.id ?? null,
      senderId: session.user.id,
    });

    return NextResponse.json({ ok: true });
  });
}
