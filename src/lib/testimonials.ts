import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

// Consent-based testimonial publishing (#1096/#1098/#1100).
//
// The chain: an evaluation's comment may only surface publicly when BOTH the
// author (their words) and the subject (it is about them) hold an active
// TESTIMONIAL consent, an admin has drafted a publicExcerpt, the author has
// approved that exact wording, and an admin has published it. Every gate is
// re-checked at read time, so a revoked consent takes effect on the very next
// request — nothing waits for a cron.

const ACTIVE_TESTIMONIAL_CONSENT = {
  consents: { some: { type: 'TESTIMONIAL' as const, grantedAt: { not: null }, revokedAt: null } },
};

// The subject of an evaluation is the relation participant who is not the
// author; for an admin-authored evaluation both participants count as
// subjects (fail-closed: everyone written about must have consented).
function subjectConsentWhere() {
  return {
    relation: {
      mentor: ACTIVE_TESTIMONIAL_CONSENT,
      mentee: ACTIVE_TESTIMONIAL_CONSENT,
    },
  };
}

// Published stories, all four gates enforced in one query (#1100):
// published + shared + author consent + subject consent. Both relation sides
// must hold the consent, which by construction covers the author when the
// author is a participant; a non-participant (admin) author is additionally
// checked via authorId in the consent-holding user set below.
export async function listPublishedStories(limit = 12) {
  const rows = await prisma.evaluation.findMany({
    where: {
      sharedPublicly: true,
      publishedAt: { not: null },
      publicExcerpt: { not: null },
      excerptApprovedAt: { not: null },
      ...subjectConsentWhere(),
    },
    orderBy: { publishedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      publicExcerpt: true,
      publishedAt: true,
      authorId: true,
      relation: {
        select: {
          mentorId: true,
          menteeId: true,
          mentor: { select: { id: true, fullName: true, publicProfile: true, testimonialNameStyle: true } },
          mentee: { select: { id: true, fullName: true, publicProfile: true, testimonialNameStyle: true } },
        },
      },
    },
  });

  // PII rule (#1100): only the excerpt, the author's display name (formatted
  // per their own preference), their role in the relation and the date leave
  // the server. Never scores, the original comment, or contact fields.
  return rows
    .map((e) => {
      const author =
        e.authorId === e.relation.mentorId
          ? { user: e.relation.mentor, role: 'mentor' as const }
          : e.authorId === e.relation.menteeId
            ? { user: e.relation.mentee, role: 'mentee' as const }
            : null;
      // Admin-authored evaluations have no participant author to attribute —
      // they never surface as testimonials.
      if (!author) return null;
      return {
        id: e.id,
        excerpt: e.publicExcerpt!,
        role: author.role,
        name: formatTestimonialName(author.user.fullName, author.user.testimonialNameStyle),
        profileUrl: author.user.publicProfile ? `/p/${author.user.id}` : null,
        publishedAt: e.publishedAt!.toISOString(),
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
}

// "fullname" is an explicit choice; anything else (null, unknown value) falls
// back to initials — the privacy-first default (#1096).
export function formatTestimonialName(fullName: string, style: string | null | undefined): string {
  if (style === 'fullname') return fullName;
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0].toLocaleUpperCase('tr')}.`)
    .join(' ');
}

// Revoking the TESTIMONIAL consent unpublishes everything the user is author
// OR subject of, in the same request (#1096) — a revoked consent must never
// leave a story live until some scheduled cleanup.
export async function revokePublishedFor(userId: string) {
  const affected = await prisma.evaluation.findMany({
    where: {
      publishedAt: { not: null },
      OR: [{ authorId: userId }, { relation: { OR: [{ mentorId: userId }, { menteeId: userId }] } }],
    },
    select: { id: true },
  });
  if (affected.length === 0) return 0;
  await prisma.evaluation.updateMany({
    where: { id: { in: affected.map((e) => e.id) } },
    data: { publishedAt: null, sharedPublicly: false },
  });
  await logActivity({
    action: 'testimonial.unpublish',
    actorId: userId,
    targetType: 'evaluation',
    targetId: affected.map((e) => e.id).join(',').slice(0, 191),
    detail: 'consent revoked',
  });
  return affected.length;
}
