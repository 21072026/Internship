import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { getLocale } from '@/i18n/server';
import { getDictionary } from '@/i18n/dictionaries';
import { renderNotification } from '@/lib/notificationText';

// GET — the current user downloads all of their own data as JSON (GDPR-style).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
  const id = session.user.id;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, fullName: true, role: true, phone: true, whatsapp: true,
      city: true, birthDate: true, university: true, department: true, graduationYear: true,
      skills: true, cvUrl: true, publicProfile: true, profileViews: true, createdAt: true, consentAt: true,
    },
  });
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const relationInclude = {
    company: { select: { name: true } },
    interactions: { select: { date: true, type: true, notes: true } },
    meetings: { select: { title: true, scheduledAt: true, rsvp: true } },
  };
  const [asMentee, asMentor, notifications] = await Promise.all([
    prisma.mentorshipRelation.findMany({
      where: { menteeId: id },
      include: { ...relationInclude, mentor: { select: { fullName: true } } },
    }),
    prisma.mentorshipRelation.findMany({
      where: { mentorId: id },
      include: { ...relationInclude, mentee: { select: { fullName: true } } },
    }),
    prisma.notification.findMany({ where: { userId: id }, select: { type: true, text: true, params: true, createdAt: true } }),
  ]);

  // i18n rows (#921) store params instead of text — render them in the user's
  // locale so the export carries the content, not just a key.
  const locale = await getLocale();
  const dict = getDictionary(locale);
  const renderedNotifications = notifications.map((n) => ({
    type: n.type,
    text: renderNotification(n, dict, locale),
    createdAt: n.createdAt,
  }));

  await logActivity({ action: 'account.export', actorId: id, actorEmail: user.email });

  const payload = { exportedAt: new Date().toISOString(), user, mentorships: { asMentee, asMentor }, notifications: renderedNotifications };
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="my-data.json"`,
    },
  });
  });
}
