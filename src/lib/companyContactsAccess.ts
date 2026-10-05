/**
 * The door every address-book write (#2442) goes through: a signed-in ADMIN of
 * an org whose product has the `companies` module, and a company inside that
 * admin's tenant. Another tenant's company id is the same 404 as one that does
 * not exist (#2542). Reads have their own, wider door in the GET handler.
 */
import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { normalizeContact, type ContactFields } from '@/lib/companyContactsRule';
import type { CompanyRef } from '@/lib/companyContacts';

export type AdminCompany = { session: Session; company: CompanyRef & { name: string } };

/**
 * The session + company, or the response that refuses the request. The caller
 * reads the session itself (`getServerSession` in the handler — what
 * scripts/check-route-auth.mjs looks for) and hands it over.
 */
export async function adminCompany(session: Session | null, companyId: string): Promise<AdminCompany | NextResponse> {
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const gated = await requireCapability(session.user.orgId, 'companies');
  if (gated) return gated;
  const company = await findTenantCompany(session, companyId);
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  return { session, company };
}

/** A company of the caller's tenant, or null. */
export async function findTenantCompany(session: Session, companyId: string) {
  return prisma.company.findFirst({
    where: withinTenant({ id: companyId }, await tenantWhere(session)),
    select: { id: true, orgId: true, name: true },
  });
}

const contactSchema = z.object({
  name: z.string().trim().min(1).max(TEXT_LIMITS.companyContactName),
  email: z.string().trim().email().max(TEXT_LIMITS.companyContactEmail).optional().or(z.literal('')).nullable(),
  phone: z.string().trim().max(TEXT_LIMITS.companyContactPhone).optional().nullable(),
  position: z.string().trim().max(TEXT_LIMITS.companyContactPosition).optional().nullable(),
});

/** Parse and normalize a contact body; null when it is not one. */
export async function readContact(request: Request): Promise<ContactFields | null> {
  const parsed = contactSchema.safeParse(await request.json().catch(() => null));
  return parsed.success ? normalizeContact(parsed.data) : null;
}

export const DUPLICATE_EMAIL = () =>
  NextResponse.json({ code: 'duplicate_email', error: 'This address is already in the account’s contacts.' }, { status: 409 });
