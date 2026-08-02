import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isValidTimeZone } from '@/lib/timezone';
import { withTenantScope } from '@/lib/orgContext';

const bodySchema = z.object({
  timezone: z.string().max(80).refine(isValidTimeZone, { message: 'Invalid IANA timezone' }),
});

// POST — record the zone the browser reports, but ONLY for a profile that has
// none yet. Emails and stored notification texts are rendered server-side in the
// recipient's zone (#1030); without this, everyone who never opened the profile
// form would read meeting times on the deployment's default clock instead of
// their own. An explicitly chosen zone is never overwritten — that is the whole
// point of the `timezone: null` guard below, and why this is a separate endpoint
// rather than a PUT /api/profile with a `timezone` field.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return new NextResponse(null, { status: 204 });
  // Not the real user's browser — don't write their profile from it.
  if (session.user.impersonatorId) return new NextResponse(null, { status: 204 });

  return await withTenantScope(session, async () => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new NextResponse(null, { status: 204 });

    try {
      const res = await prisma.user.updateMany({
        where: { id: session.user.id, OR: [{ timezone: null }, { timezone: '' }] },
        data: { timezone: parsed.data.timezone },
      });
      return NextResponse.json({ saved: res.count > 0 });
    } catch {
      // A best-effort convenience write must never break the page.
      return new NextResponse(null, { status: 204 });
    }
  });
}
