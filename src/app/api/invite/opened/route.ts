import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';

const schema = z.object({ token: z.string().min(1) });

// POST { token } — public. Called when an invitee opens the registration link.
// Records the first open (openedAt) so admins can see the invite was clicked,
// even before the invitee finishes registering. Idempotent: only the first
// open is stamped, and used/expired invitations are ignored.
export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'invite-opened', { limit: 30, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid token' }, { status: 400 });

  const invite = await prisma.invitationToken.findUnique({ where: { token: parsed.data.token } });
  // Silently succeed for unknown/consumed tokens — this is a best-effort signal,
  // not an auth check, and we don't want to leak which tokens exist.
  if (invite && !invite.used && !invite.openedAt && invite.expiresAt > new Date()) {
    await prisma.invitationToken.update({ where: { id: invite.id }, data: { openedAt: new Date() } });
  }
  return NextResponse.json({ ok: true });
}
