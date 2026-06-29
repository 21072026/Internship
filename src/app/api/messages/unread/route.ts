import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET — number of unread incoming messages across the viewer's threads.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const count = await prisma.message.count({
    where: {
      readAt: null,
      senderId: { not: session.user.id },
      relation: { OR: [{ mentorId: session.user.id }, { menteeId: session.user.id }] },
    },
  });
  return NextResponse.json({ count });
}
