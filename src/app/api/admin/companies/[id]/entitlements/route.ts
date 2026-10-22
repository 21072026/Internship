import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getCompanyFeatureSources, type FeatureSource, type PremiumFeature } from '@/lib/entitlements';
import { withTenantScope } from '@/lib/orgContext';

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  return session;
}

// The resolved map ({ FEATURE: boolean } — org plan/grant OR the company's own
// override) plus where each answer comes from, so the grid can tell "included
// in the plan" from "switched on for this company" (#1733).
async function featurePayload(companyId: string) {
  const sources = await getCompanyFeatureSources(companyId);
  const features = Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.enabled])) as Record<PremiumFeature, boolean>;
  return { features, sources: sources as Record<PremiumFeature, FeatureSource> };
}

// GET — the company's premium feature map and its sources.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
  const { id } = await params;
  const company = await prisma.company.findUnique({ where: { id }, select: { id: true } });
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  return NextResponse.json(await featurePayload(id));
  });
}

// There is no PUT any more (#1734): a company's premium features are decided
// by its organisation — the plan, or a super admin's grant through
// POST /api/admin/billing/entitlements. A per-company row written here used to
// sell a feature to one company from any tenant admin's screen.
