import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { recordOrgWrite } from '@/lib/orgAudit';
import { orgAdminRefusal } from '@/lib/orgAdminGate';
import { removeSampleProgram } from '@/lib/orgSampleProgram';

// DELETE /api/admin/organizations/[id]/sample-data (#2066) — remove the
// starter pack's sample programme: exactly the rows tagged `sampleData` in
// this organization (src/lib/orgSampleProgram.ts) and what hangs off them.
// Nothing without the tag is touched.
//
// WHO: that organization's ADMIN, or a super admin of its world (orgAdminGate).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const refusal = await orgAdminRefusal(session, id, 'DELETE /api/admin/organizations/[id]/sample-data');
  if (refusal) return refusal;
  const removed = await removeSampleProgram(id);
  await recordOrgWrite({
    orgId: id,
    action: 'organization.sample_data_removed',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    request: req,
    detail: `${removed.users} people, ${removed.relations} pairs, ${removed.companies} companies, ${removed.requisitions} requisitions`,
  });
  return NextResponse.json({ removed });
}
