import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { decideInterviewRequest } from '@/lib/interviewRequestDecision';

// PATCH — a mentor (or an admin) approves or declines an interview request.
// The body is src/lib/interviewRequestDecision.ts, shared with the chat
// card's Approve/Decline (#1949).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return decideInterviewRequest(session, id, await request.json().catch(() => null), request);
}
