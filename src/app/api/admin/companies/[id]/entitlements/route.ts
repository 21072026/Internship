import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getCompanyFeatureSources, setCompanyFeature, isPremiumFeature, type FeatureSource, type PremiumFeature } from '@/lib/entitlements';
import { logActivity } from '@/lib/activity';
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

const putSchema = z.object({ feature: z.string(), enabled: z.boolean() });

// PUT — toggle one premium feature for the company.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
  const { id } = await params;

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isPremiumFeature(parsed.data.feature)) {
    return NextResponse.json({ error: 'Invalid feature' }, { status: 400 });
  }

  const company = await prisma.company.findUnique({ where: { id }, select: { id: true } });
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  await setCompanyFeature(id, parsed.data.feature, parsed.data.enabled);
  await logActivity({
    action: parsed.data.enabled ? 'admin.entitlement.enable' : 'admin.entitlement.disable',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'company',
    targetId: id,
    detail: parsed.data.feature,
  });
  return NextResponse.json(await featurePayload(id));
  });
}
