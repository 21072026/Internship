import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { getConsents, setConsent } from '@/lib/consent';
import { logActivity } from '@/lib/activity';
import type { ConsentType } from '@prisma/client';

const CONSENT_TYPES = ['AI_CV_PARSING', 'ACTIVITY_TRACKING', 'TALENT_POOL_VISIBILITY'] as const;

const bodySchema = z.object({
  type: z.enum(CONSENT_TYPES),
  granted: z.boolean(),
});

// GET — the current user's consents as a { TYPE: boolean } map.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ consents: await getConsents(session.user.id) });
}

// POST — grant or revoke a consent for the current user.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  await setConsent(session.user.id, parsed.data.type as ConsentType, parsed.data.granted);
  await logActivity({
    action: parsed.data.granted ? 'consent.grant' : 'consent.revoke',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'consent',
    targetId: parsed.data.type,
  });
  return NextResponse.json({ ok: true, consents: await getConsents(session.user.id) });
}
