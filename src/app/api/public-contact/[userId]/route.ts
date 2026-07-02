import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';

// Public contact form → a notification to the profile owner (EPIC: public
// profile). Anti-spam without an external captcha (blocked by our CSP): a
// honeypot field, a minimum render-to-submit time, and a per-IP rate limit.
const schema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200),
  message: z.string().min(1).max(2000),
  // Honeypot — accept any string so a filled value passes validation and is
  // dropped silently by the handler (a 400 here would leak the trap to bots).
  website: z.string().max(500).optional(),
  // Client-stamped render time (ms epoch) to reject instant/bot submits.
  renderedAt: z.number().int().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  // 3 messages/hour/IP, plus a global bucket to blunt distributed spam bursts.
  const limited = enforceRateLimit(request, 'public-contact', { limit: 3, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;

  const { userId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { name, email, message, website, renderedAt } = parsed.data;

  // Honeypot filled, or submitted implausibly fast (<3s) → silently accept
  // (200) so bots get no signal, but drop the message.
  const tooFast = typeof renderedAt === 'number' && Date.now() - renderedAt < 3000;
  if (website || tooFast) return NextResponse.json({ ok: true });

  // Only owners with a public profile can be contacted.
  const owner = await prisma.user.findFirst({
    where: { id: userId, publicProfile: true },
    select: { id: true },
  });
  if (!owner) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const preview = message.length > 300 ? `${message.slice(0, 300)}…` : message;
  await prisma.notification.create({
    data: {
      userId: owner.id,
      type: 'public_contact',
      text: `${name} (${email}): ${preview}`,
    },
  });

  return NextResponse.json({ ok: true });
}
