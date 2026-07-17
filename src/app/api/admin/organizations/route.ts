import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { ORG_PLAN_KEYS, planLimits, isOrgPlan, type OrgPlan } from '@/lib/orgPlans';
import { isHexColor } from '@/lib/branding';

// Multi-tenancy (#544/#547): super-admin management of Organizations (tenants).
// Phase 1 is additive/foundational — orgId is nullable and not yet enforced in
// queries, so this screen lets an admin create tenants, set their plan, and see
// usage vs. the plan's (advisory) limits. Query isolation lands in a later slice.

// GET — all organizations with plan, limits and per-tenant usage (admin).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const orgs = await prisma.organization.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: {
          users: true,
          sources: true,
          cohorts: true,
          companies: true,
          projects: true,
          relations: true,
        },
      },
    },
  });

  return NextResponse.json({
    plans: ORG_PLAN_KEYS,
    organizations: orgs.map((o) => {
      const plan = o.plan as OrgPlan;
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        plan,
        limits: planLimits(plan),
        branding: {
          brandName: o.brandName,
          brandLogoUrl: o.brandLogoUrl,
          brandColor: o.brandColor,
          supportEmail: o.supportEmail,
        },
        createdAt: o.createdAt,
        counts: {
          users: o._count.users,
          sources: o._count.sources,
          cohorts: o._count.cohorts,
          companies: o._count.companies,
          projects: o._count.projects,
          relations: o._count.relations,
        },
      };
    }),
  });
}

// URL-safe slug: lowercase, alphanumerics + single hyphens, no leading/trailing.
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  plan: z.enum(['FREE', 'PRO', 'ENTERPRISE']).optional(),
});

// POST — create an organization (admin).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const name = parsed.data.name.trim();
  const slug = slugify(parsed.data.slug || name);
  if (!slug) return NextResponse.json({ error: 'Could not derive a valid slug from the name' }, { status: 400 });

  const existing = await prisma.organization.findUnique({ where: { slug } });
  if (existing) return NextResponse.json({ error: 'An organization with that slug already exists' }, { status: 409 });

  const organization = await prisma.organization.create({
    data: { name, slug, plan: parsed.data.plan ?? 'FREE' },
  });
  return NextResponse.json({ organization }, { status: 201 });
}

// Empty string clears an optional branding field (stored as null).
const optionalText = z.string().max(200).optional();
const patchSchema = z.object({
  id: z.string().min(1),
  plan: z.string().refine(isOrgPlan, 'Invalid plan').optional(),
  brandName: optionalText,
  brandLogoUrl: z.string().max(2000).optional(),
  brandColor: z.string().optional(),
  supportEmail: z.string().max(200).optional(),
});

function orNull(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined; // field not provided → leave unchanged
  const t = v.trim();
  return t.length ? t : null; // blank → clear
}

// PATCH — change an organization's plan and/or branding (admin).
export async function PATCH(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const { id, plan, brandName, brandLogoUrl, brandColor, supportEmail } = parsed.data;

  // Validate an explicitly-set (non-blank) brand color as a hex value.
  if (brandColor && brandColor.trim() && !isHexColor(brandColor)) {
    return NextResponse.json({ error: 'Brand color must be a hex value like #2563eb' }, { status: 400 });
  }

  const existing = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (plan !== undefined) data.plan = plan;
  const bn = orNull(brandName); if (bn !== undefined) data.brandName = bn;
  const bl = orNull(brandLogoUrl); if (bl !== undefined) data.brandLogoUrl = bl;
  const bc = orNull(brandColor); if (bc !== undefined) data.brandColor = bc;
  const se = orNull(supportEmail); if (se !== undefined) data.supportEmail = se;
  if (Object.keys(data).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });

  const organization = await prisma.organization.update({ where: { id }, data });
  return NextResponse.json({ organization });
}
