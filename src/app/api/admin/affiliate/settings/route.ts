import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { nextContractVersion } from '@/lib/affiliateContractRule';

// The organisation's programme copy and contract (docs/affiliate-module.md, decision 14).
// Saving a changed contract bumps its version; partners must accept the new one.

const LOCALES = ['en', 'tr', 'de'] as const;
const copySchema = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(5000) });
const putSchema = z.object({
  landing: z.object({ en: copySchema, tr: copySchema.optional(), de: copySchema.optional() }),
  contract: z.object({ en: z.string().max(40000), tr: z.string().max(40000).optional(), de: z.string().max(40000).optional() }),
});

async function requireAdminOrg() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN' || !session.user.orgId) return null;
  return session;
}

export async function GET() {
  const session = await requireAdminOrg();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = session.user.orgId as string;
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;
  return withTenantScope(session, async () => {
    const settings = await prisma.affiliateProgramSettings.findUnique({ where: { orgId } });
    return NextResponse.json({ settings: settings ? { landing: settings.landing, contract: settings.contract, contractVersion: settings.contractVersion } : null });
  });
}

export async function PUT(request: Request) {
  const session = await requireAdminOrg();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = session.user.orgId as string;
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });

  return withTenantScope(session, async () => {
    const previous = await prisma.affiliateProgramSettings.findUnique({ where: { orgId } });
    const version = nextContractVersion(
      previous?.contractVersion ?? 0,
      (previous?.contract as Record<string, string> | null) ?? null,
      parsed.data.contract,
    );
    const saved = await prisma.affiliateProgramSettings.upsert({
      where: { orgId },
      create: {
        orgId,
        landing: parsed.data.landing as Prisma.InputJsonValue,
        contract: parsed.data.contract as Prisma.InputJsonValue,
        contractVersion: version,
      },
      update: {
        landing: parsed.data.landing as Prisma.InputJsonValue,
        contract: parsed.data.contract as Prisma.InputJsonValue,
        contractVersion: version,
      },
      select: { contractVersion: true },
    });
    return NextResponse.json({ ok: true, contractVersion: saved.contractVersion, locales: LOCALES });
  });
}
