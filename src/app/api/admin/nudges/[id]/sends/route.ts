import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { nudgeScope } from '@/lib/nudges/adminGuard';
import { listSends } from '@/lib/nudges/admin';
import { requireCapability } from '@/lib/capabilityGate';

// A rule's send history (#1686): recipient, when, channel, status and the
// triggering event's name where there was one. Newest 100.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('org.settings.write', { request });
  if ('error' in auth) return auth.error;
  // Nudges reach mentees and mentors (MKT-6a).
  const capGate = await requireCapability(auth.session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const g = await nudgeScope(auth.session);
  if ('error' in g) return g.error;
  const id = (await params).id;
  if (!(await prisma.nudgeRule.count({ where: { id, orgId: g.orgId } }))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ sends: await listSends(id, g.orgId) });
}
