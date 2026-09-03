import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { checklistGuidanceKey, setGuidanceDismissed } from '@/lib/guidance';

// POST — remember that the signed-in user closed their first-run checklist, so
// the card stays closed on their next laptop instead of on this browser only.
//
// The row written is always (session user, `checklist:<their own role>`). There
// is no userId, no key and no role in the body: an ADMIN cannot dismiss anybody
// else's checklist, because the handler has no way to name another user.
const bodySchema = z.object({ dismissed: z.boolean().optional() }).strict();

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // An empty body is the common case ("dismiss it"); anything else must parse.
  const raw = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const dismissed = parsed.data.dismissed ?? true;
    await setGuidanceDismissed(session.user.id, checklistGuidanceKey(session.user.role), dismissed);
    return NextResponse.json({ dismissed });
  });
}
