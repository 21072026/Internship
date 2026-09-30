import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { CONTACT_BASES, CONTACT_CHANNELS } from '@/lib/contactPermissionRule';
import { adminSetContactPermission, revokeContactPermission } from '@/lib/contactPermission';

/**
 * PUT — an admin records or revokes one account × channel contact permission
 * (#2577, docs/contact-permission.md).
 *
 * `{ channel, action: 'set', basis, reason? }` or `{ channel, action: 'revoke' }`.
 * What an admin may set is decided by the rule, not here
 * (src/lib/contactPermissionRule.ts): EXISTING_CUSTOMER_7_3 with a reason naming
 * the sale, INQUIRY_REPLY or NONE — never DOI_CONFIRMED, which only the address
 * owner's own click can produce. A refused write is a 400 with the rule's code.
 *
 * ADMIN only, tenant-scoped by hand like the account page it serves: another
 * tenant's company id is the same 404 as one that does not exist.
 */
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    channel: z.enum(CONTACT_CHANNELS),
    basis: z.enum(CONTACT_BASES),
    reason: z.string().max(1000).optional(),
  }),
  z.object({ action: z.literal('revoke'), channel: z.enum(CONTACT_CHANNELS) }),
]);

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gated = await requireCapability(session.user.orgId, 'companies');
    if (gated) return gated;

    const { id } = await params;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    return withTenantScope(session, async () => {
      const company = await prisma.company.findFirst({
        where: withinTenant({ id }, await tenantWhere(session)),
        select: { id: true, orgId: true, contactEmail: true },
      });
      if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
      const actor = { id: session.user.id, email: session.user.email ?? null };

      if (parsed.data.action === 'revoke') {
        await revokeContactPermission({
          orgId: company.orgId,
          companyId: company.id,
          channel: parsed.data.channel,
          via: 'ADMIN',
          address: company.contactEmail,
          actor,
          request,
        });
        return NextResponse.json({ ok: true });
      }

      const outcome = await adminSetContactPermission({
        actor,
        orgId: company.orgId,
        companyId: company.id,
        channel: parsed.data.channel,
        basis: parsed.data.basis,
        reason: parsed.data.reason ?? null,
        address: company.contactEmail,
        request,
      });
      if (outcome.kind === 'refused') {
        return NextResponse.json({ code: outcome.code, error: 'This basis cannot be recorded this way.' }, { status: 400 });
      }
      return NextResponse.json({ ok: true });
    });
  });
}
