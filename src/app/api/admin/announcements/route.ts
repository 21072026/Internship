import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';
import { sendEmail } from '@/services/emailService';
import { logger } from '@/lib/logger';

const schema = z.object({
  text: z.string().min(1).max(2000),
  link: z.string().max(500).optional(),
  email: z.boolean().optional(),
});

// POST — broadcast an announcement to every active user as an in-app
// notification, optionally also by email (respecting each user's opt-out).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { text, link, email } = parsed.data;

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, email: true, emailNotifications: true },
  });

  // Bulk-create the in-app notifications in one statement.
  await prisma.notification.createMany({
    data: users.map((u) => ({ userId: u.id, type: 'announcement', text, link: link || null })),
  });

  let emailed = 0;
  if (email) {
    const safe = text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
    const html = `<p>${safe.replace(/\n/g, '<br>')}</p>${link ? `<p><a href="${link}">${link}</a></p>` : ''}`;
    await Promise.all(
      users
        .filter((u) => u.email && u.emailNotifications)
        .map((u) =>
          sendEmail({ to: u.email, subject: 'Announcement', html }).then(
            () => { emailed++; },
            (e) => logger.error('Failed to send announcement email', { error: String(e) })
          )
        )
    );
  }

  await logActivity({ action: 'announcement.broadcast', actorId: session.user.id, actorEmail: session.user.email ?? null });
  return NextResponse.json({ recipients: users.length, emailed }, { status: 201 });
}
