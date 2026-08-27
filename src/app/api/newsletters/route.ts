import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
// The SEND decides with the group predicate, so the state this reports must use
// the same one. `emailAllowed(x, 'newsletter')` reads only the legacy key, which
// disagrees with the send for anyone who opted out through the newsletter's own
// link and then re-enabled the group: the API would answer "not subscribed"
// about mail that is still going out.
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import {
  audienceIncludesRole,
  canonicalNewsletterContent,
  isNewsletterFallback,
  newsletterImageUrl,
  normalizeNewsletterContent,
  resolveNewsletterContent,
  type NewsletterAudience,
} from '@/lib/newsletter';

/**
 * GET — the reader's archive of past issues (#1469).
 *
 * ── WHY THERE IS NO "SINCE YOU JOINED" CUTOFF ──────────────────────────────
 * The announcement feed deliberately hides anything broadcast before an account
 * existed (#1161): an operational message read three weeks late is noise. A
 * newsletter is the opposite kind of thing. "Write results, not duties" is as
 * useful to someone who signed up yesterday as to someone who was here in
 * March, and a new mentee arriving to an archive of ten issues of career advice
 * is the archive working, not leaking.
 *
 * What IS filtered is the audience: a mentee never sees a mentor-only issue,
 * and only mentors see the mentor block inside a shared one — the same rule the
 * dispatcher applies, so the archive and the inbox agree.
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '10', 10) || 10));

  // Read from the DB, never from the JWT: a token minted before this shipped
  // carries no newsletter preference, and the role in a stale session must not
  // decide which audience's mail someone can read back.
  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true },
  });
  if (!me) return NextResponse.json({ newsletters: [], total: 0, page, pageSize, subscribed: false });

  // Audience is an enum, so which values include this role is decidable up
  // front — that keeps the filter in the query instead of over-fetching and
  // discarding rows in JS (which would break the pagination count).
  const audiences = (['MENTEE', 'MENTOR', 'BOTH'] as NewsletterAudience[]).filter((a) =>
    audienceIncludesRole(a, me.role)
  );
  const where = { status: 'SENT' as const, audience: { in: audiences } };

  const [total, issues] = await Promise.all([
    prisma.newsletter.count({ where }),
    prisma.newsletter.findMany({
      where,
      orderBy: { sentAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        audience: true,
        content: true,
        sentAt: true,
        image: { select: { id: true } },
      },
    }),
  ]);

  return NextResponse.json({
    // Resolved server-side into this reader's language, so the client stays a
    // plain renderer and the other languages never travel to a browser that
    // cannot use them.
    newsletters: issues.flatMap(({ image, content, ...issue }) => {
      const variants = normalizeNewsletterContent(content);
      const canonical = canonicalNewsletterContent(variants);
      // An issue with no complete language cannot have been sent, but the
      // archive is a read path: skip rather than render an empty card.
      if (!canonical) return [];
      const resolved = resolveNewsletterContent(variants, canonical, me.preferredLanguage);
      return [{
        id: issue.id,
        audience: issue.audience,
        sentAt: issue.sentAt,
        subject: resolved.subject,
        intro: resolved.intro,
        tips: resolved.tips,
        action: resolved.action ?? null,
        cta: resolved.cta ?? null,
        // Only mentors are shown the mentor block, here as in the e-mail.
        mentorNote: audienceIncludesRole(issue.audience as NewsletterAudience, me.role) && (me.role === 'MENTOR' || me.role === 'ADMIN')
          ? resolved.mentorNote ?? null
          : null,
        // True when this issue was written in other languages but not the
        // reader's — the UI says so instead of silently presenting a foreign
        // text as if it had been meant for them.
        languageFallback: isNewsletterFallback(variants, me.preferredLanguage),
        imageUrl: image ? newsletterImageUrl(issue.id) : null,
      }];
    }),
    total,
    page,
    pageSize,
    // So the archive can offer "turn these back on" to someone who left, and
    // say nothing to someone who is still subscribed.
    subscribed: emailGroupAllowedForCategory(me, 'newsletter'),
  });
}
