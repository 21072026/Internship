import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { acceptanceReport, AgreementWriteError, AGREEMENT_LOCALES, listAgreementVersions, publishAgreementVersion } from '@/lib/mentoringAgreement';

// The mentoring agreement's admin surface (#1790), for the caller's own org.
//   GET   — every version (a fresh org gets the starter template as v1) and,
//           per active pairing, whether both sides accepted the version in force
//   POST  — publish a NEW version; the server numbers it
//   PATCH / PUT / DELETE — refused (405 `immutable`): a version somebody may
//           have accepted is never edited or removed. Save as a new version.

const body = z.string().trim().max(20_000).optional();
const publishSchema = z
  .object({
    bodies: z.object({ en: body, tr: body, de: body }).strict(),
    authoritativeLocale: z.enum(AGREEMENT_LOCALES),
    effectiveFrom: z.string().datetime().optional(),
  })
  .strict();

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  return session;
}

export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const refusal = await requireCapability(session.user.orgId, 'mentorship');
  if (refusal) return refusal;
  return withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    // Sequential on purpose: both install the template on a fresh org, and two
    // concurrent installs deadlock on MySQL's insert locks.
    const versions = await listAgreementVersions(orgId);
    const report = await acceptanceReport(orgId);
    return NextResponse.json({ versions, report });
  });
}

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const refusal = await requireCapability(session.user.orgId, 'mentorship');
  if (refusal) return refusal;
  const parsed = publishSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', code: 'invalid' }, { status: 400 });
  return withTenantScope(session, async () => {
    try {
      const { version } = await publishAgreementVersion(resolveOrgId(session), {
        bodies: parsed.data.bodies,
        authoritativeLocale: parsed.data.authoritativeLocale,
        effectiveFrom: parsed.data.effectiveFrom ? new Date(parsed.data.effectiveFrom) : undefined,
        createdById: session.user.id,
      });
      return NextResponse.json({ version }, { status: 201 });
    } catch (error) {
      if (error instanceof AgreementWriteError) return NextResponse.json({ error: error.code, code: error.code }, { status: error.status });
      throw error;
    }
  });
}

async function immutable() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ error: 'A published agreement version is never edited. Save a new version.', code: 'immutable' }, { status: 405 });
}

export async function PATCH() {
  return immutable();
}

export async function PUT() {
  return immutable();
}

export async function DELETE() {
  return immutable();
}
