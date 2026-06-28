import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';

// Public endpoint — the mentee responds to a meeting invite via the token in
// their email. No auth: the unguessable token is the credential.

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') || '';
  const meeting = await prisma.meeting.findUnique({
    where: { rsvpToken: token },
    select: { title: true, scheduledAt: true, meetLink: true, rsvp: true },
  });
  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ meeting });
}

const schema = z.object({ token: z.string().min(1), response: z.enum(['yes', 'no']) });

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'rsvp', { limit: 20, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { token, response } = parsed.data;
  const meeting = await prisma.meeting.findUnique({ where: { rsvpToken: token } });
  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.meeting.update({
    where: { id: meeting.id },
    data: { rsvp: response === 'yes' ? 'ACCEPTED' : 'DECLINED' },
  });
  await notify(
    meeting.createdById,
    'rsvp',
    `A mentee ${response === 'yes' ? 'accepted' : 'declined'} the meeting "${meeting.title}".`,
    '/mentor/meetings'
  );
  return NextResponse.json({ ok: true, rsvp: response === 'yes' ? 'ACCEPTED' : 'DECLINED' });
}
