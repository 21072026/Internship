import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';
import { sendEmail } from '@/services/emailService';
import { logger } from '@/lib/logger';
import { emailAllowed } from '@/lib/notificationPrefs';
import { withTenantScope } from '@/lib/orgContext';

const schema = z.object({
  // Long-form announcements (release notes, articles) are allowed; the previous
  // 2 000-char cap rejected them with a bare 400. Kept bounded to protect the
  // per-user notification fan-out.
  text: z.string().min(1).max(20000),
  link: z.string().max(500).optional(),
  email: z.boolean().optional(),
});

// GET — paginated history of past broadcasts (most recent first).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const pageSize = 20;

  const [total, announcements] = await Promise.all([
    prisma.announcement.count(),
    prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const senderIds = [...new Set(announcements.map((a) => a.sentById))];
  const senders = await prisma.user.findMany({ where: { id: { in: senderIds } }, select: { id: true, fullName: true } });
  const senderName = new Map(senders.map((s) => [s.id, s.fullName]));

  return NextResponse.json({
    announcements: announcements.map((a) => ({ ...a, sentByName: senderName.get(a.sentById) ?? null })),
    total,
    page,
    pageSize,
  });
  });
}

// POST — broadcast an announcement to every active user as an in-app
// notification, optionally also by email (respecting each user's opt-out).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const { text, link, email } = parsed.data;

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, email: true, emailNotifications: true, notificationPrefs: true },
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
        .filter((u) => u.email && emailAllowed(u, 'announcements'))
        .map((u) =>
          sendEmail({ to: u.email, subject: 'Announcement', html }).then(
            () => { emailed++; },
            (e) => logger.error('Failed to send announcement email', { error: String(e) })
          )
        )
    );
  }

  await prisma.announcement.create({
    data: { text, link: link || null, sentById: session.user.id, recipientCount: users.length, emailedCount: emailed },
  });

  await logActivity({ action: 'announcement.broadcast', actorId: session.user.id, actorEmail: session.user.email ?? null });
  return NextResponse.json({ recipients: users.length, emailed }, { status: 201 });
  });
}
