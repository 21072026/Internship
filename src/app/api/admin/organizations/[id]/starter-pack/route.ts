import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { recordOrgWrite } from '@/lib/orgAudit';
import { getLocale } from '@/i18n/server';
import { applyOrgStarterPack } from '@/lib/orgStarterPack';
import { orgAdminRefusal } from '@/lib/orgAdminGate';

// POST /api/admin/organizations/[id]/starter-pack (#2066) — apply the tenant
// starter pack: stages, service levels, document requirements, an evaluation
// framework per scope and goal templates; with `{ sampleProgram: true }` also
// the labelled sample programme (src/lib/orgSampleProgram.ts). Idempotent
// (src/lib/orgStarterPack.ts): a second call creates nothing and never
// overwrites what the tenant edited, so this is also what "re-apply" calls.
//
// WHO: that organization's ADMIN, or a super admin of its world (orgAdminGate).

const bodySchema = z.object({ sampleProgram: z.boolean().optional() }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const refusal = await orgAdminRefusal(session, id, 'POST /api/admin/organizations/[id]/starter-pack');
  if (refusal) return refusal;

  // The body is optional: none is the pack without a sample programme.
  const raw = await req.text();
  let body: unknown = {};
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });

  const summary = await applyOrgStarterPack(id, { locale: await getLocale(), sampleProgram: parsed.data.sampleProgram });
  const created = Object.values(summary).reduce((n, s) => n + (s?.created ?? 0), 0);
  await recordOrgWrite({
    orgId: id,
    action: 'organization.starter_pack',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    detail: `created ${created}${parsed.data.sampleProgram ? ' (with sample programme)' : ''}`,
    request: req,
  });
  return NextResponse.json({ summary });
}
