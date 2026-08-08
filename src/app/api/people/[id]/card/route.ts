import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { canViewPersonCard, loadPersonCard } from '@/lib/personCard';

// GET — the compact summary behind a person's name (#1166).
//
// Separate from /api/users/[id] (admin-only, the full record) and from
// /api/public-contact/[userId] (public profiles only, so it cannot answer for
// the colleagues you actually work with). This one answers exactly the question
// the hover card asks: "who is this name, and what can I do about them?"
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const viewer = { id: session.user.id, role: session.user.role };

    // 403 for "not allowed" and 404 for "no such person" are the same answer to
    // a prober, so both come back as 404 — the card is a lookup by user id, and
    // distinguishing the two would turn it into an account-existence oracle.
    if (!(await canViewPersonCard(viewer, id))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const person = await loadPersonCard(viewer, id);
    if (!person) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return NextResponse.json({ person });
  });
}
