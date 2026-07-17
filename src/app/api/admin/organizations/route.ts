import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

// Multi-tenancy (#544): super-admin management of Organizations (tenants).
// Phase 1 is additive/foundational — orgId is nullable and not yet enforced in
// queries, so this screen simply lets an admin create tenants and see how many
// rows are already assigned to each. Enforcement (query isolation) lands later.

// GET — all organizations with per-tenant row counts (admin).
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
    organizations: orgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      createdAt: o.createdAt,
      counts: {
        users: o._count.users,
        sources: o._count.sources,
        cohorts: o._count.cohorts,
        companies: o._count.companies,
        projects: o._count.projects,
        relations: o._count.relations,
      },
    })),
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

const schema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
});

// POST — create an organization (admin).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const name = parsed.data.name.trim();
  const slug = slugify(parsed.data.slug || name);
  if (!slug) return NextResponse.json({ error: 'Could not derive a valid slug from the name' }, { status: 400 });

  const existing = await prisma.organization.findUnique({ where: { slug } });
  if (existing) return NextResponse.json({ error: 'An organization with that slug already exists' }, { status: 409 });

  const organization = await prisma.organization.create({ data: { name, slug } });
  return NextResponse.json({ organization }, { status: 201 });
}
