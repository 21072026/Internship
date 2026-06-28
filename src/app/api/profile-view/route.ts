import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const schema = z.object({ userId: z.string().min(1) });

// POST — count a public-profile view. De-duplicated per viewer for an hour via
// a cookie, and never counts the owner viewing their own profile.
export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Invalid' }, { status: 400 });
  const { userId } = parsed.data;

  const session = await getServerSession(authOptions);
  if (session?.user?.id === userId) return NextResponse.json({ ok: true, counted: false });

  const cookieName = `pv_${userId}`;
  const seen = request.headers.get('cookie')?.includes(`${cookieName}=1`);
  if (seen) return NextResponse.json({ ok: true, counted: false });

  // Only count if the profile is actually public.
  const target = await prisma.user.findFirst({ where: { id: userId, publicProfile: true }, select: { id: true } });
  if (!target) return NextResponse.json({ ok: true, counted: false });

  await prisma.user.update({ where: { id: userId }, data: { profileViews: { increment: 1 } } });

  const res = NextResponse.json({ ok: true, counted: true });
  res.cookies.set(cookieName, '1', { maxAge: 60 * 60, httpOnly: true, sameSite: 'lax', path: '/' });
  return res;
}
