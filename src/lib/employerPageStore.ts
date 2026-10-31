// The public employer page (#1867) — the Prisma half: the slug assignment and
// the one read the page and its API share. Server-only.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { EMPLOYER_SLUG_MAX, employerSlugBase, employerSlugCandidate, isEmployerSlug, isPublicEmployer } from '@/lib/employerPage';
import { kebabSlug } from '@/lib/transliterate';

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Give a company its slug the first time its profile is published. A company
 * that already has one keeps it — a public URL that moves is a broken link.
 * Unique per tenant (`@@unique([orgId, slug])`); a taken name gets `-2`, `-3`…
 * and a concurrent publisher who wins the same candidate makes us try the next.
 */
export async function ensureEmployerSlug(company: { id: string; orgId: string | null; name: string; slug: string | null }): Promise<string | null> {
  if (company.slug) return company.slug;
  if (!company.orgId) return null;
  const base = employerSlugBase(kebabSlug(company.name, EMPLOYER_SLUG_MAX));
  for (let n = 1; n <= 50; n++) {
    const candidate = employerSlugCandidate(base, n);
    const taken = await prisma.company.findFirst({ where: { orgId: company.orgId, slug: candidate }, select: { id: true } });
    if (taken) continue;
    try {
      // Guarded on `slug: null`, so a slug set meanwhile is never overwritten.
      const set = await prisma.company.updateMany({ where: { id: company.id, slug: null }, data: { slug: candidate } });
      if (set.count === 1) return candidate;
      const now = await prisma.company.findUnique({ where: { id: company.id }, select: { slug: true } });
      return now?.slug ?? null;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  return null;
}

export interface PublicEmployer {
  name: string;
  logoUrl: string | null;
  about: string | null;
  industry: string | null;
  size: string | null;
  websiteUrl: string | null;
  roles: { id: string; title: string; city: string | null; workMode: string | null; startDate: string | null }[];
}

/**
 * The employer at `slug` in `orgId`, or null when it may not be shown. The
 * select is the whole public surface: no contact e-mail, no address, no quota,
 * no internal description. Roles are the job board's own visibility rule:
 * OPEN with a seat still free.
 */
export async function loadPublicEmployer(orgId: string, slug: string): Promise<PublicEmployer | null> {
  if (!isEmployerSlug(slug)) return null;
  const company = await prisma.company.findFirst({
    where: { orgId, slug, isPublicProfile: true, verificationStatus: 'VERIFIED' },
    select: {
      id: true, name: true, logoUrl: true, about: true, industry: true, size: true, websiteUrl: true,
      slug: true, isPublicProfile: true, verificationStatus: true,
    },
  });
  if (!company || !isPublicEmployer(company)) return null;
  const roles = await prisma.requisition.findMany({
    where: { orgId, companyId: company.id, status: 'OPEN', filled: { lt: prisma.requisition.fields.openings } },
    select: { id: true, title: true, city: true, workMode: true, startDate: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 50,
  });
  return {
    name: company.name,
    logoUrl: company.logoUrl,
    about: company.about,
    industry: company.industry,
    size: company.size,
    websiteUrl: company.websiteUrl,
    roles: roles.map((r) => ({ ...r, startDate: r.startDate?.toISOString() ?? null })),
  };
}
