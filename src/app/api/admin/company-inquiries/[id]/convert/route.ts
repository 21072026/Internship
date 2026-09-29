import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { isLocale } from '@/i18n/config';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { convertInquiryToCompanyAccount } from '@/lib/companyProvisioning';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { verticalFor } from '@/lib/verticalContext';
import { requireCapability } from '@/lib/capabilityGate';
import { findLeadOwner, resolveDefaultLeadOwner } from '@/lib/leadOwner';
import { convertInquiryToMarketingLead } from '@/lib/inquiryLead';

// Convert an inbound enquiry into a Company plus an invited COMPANY login, in
// one action (#1863). The mechanics — and the reasoning about ordering,
// idempotence and what is never returned — live in
// src/lib/companyProvisioning.ts; this handler is authorisation, validation and
// the HTTP shape only.
//
// The fields are prefilled from the enquiry on the client and editable before
// submit, because what a company types into a public form ("acme", "info@…") is
// not necessarily what the record should say.
//
// In a MARKETING org the same button means something else (#2569): the demo
// request becomes an account + stand-in lead + funnel record at the first
// stage, through the marketing import's writer (src/lib/inquiryLead.ts) — no
// login and no invitation, because the marketing product sells to the company
// rather than giving it a seat. The owner is `ownerId` when the body names one,
// else the org's default lead owner (#2580), else the admin who pressed the
// button: a funnel record cannot exist without an owner, and the person
// converting it is the one who has just decided it is a lead.
const convertSchema = z.object({
  // MARKETING only: who owns the new funnel record. Validated as an active
  // ADMIN/MENTOR of the caller's own org; anything else is a 400.
  ownerId: z.string().trim().min(1).max(64).optional(),
  companyName: z.string().trim().min(1).max(TEXT_LIMITS.companyName).optional(),
  contactFullName: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(TEXT_LIMITS.companyContactEmail).optional(),
  industry: z.string().trim().max(TEXT_LIMITS.companyIndustry).optional(),
  size: z.string().trim().max(TEXT_LIMITS.companySize).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = convertSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
    const { id } = await params;

    // Another tenant's enquiry is a 404 (#2569): the lookup carries the tenant
    // itself, because the middleware injects nothing with isolation off.
    const inquiry = await prisma.companyInquiry.findFirst({
      where: withinTenant({ id }, await tenantWhere(session)),
      select: { id: true, companyName: true, contactName: true, email: true, locale: true },
    });
    if (!inquiry) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Never null: an admin whose account predates the org backfill would
    // otherwise create a Company and an invitation that both disappear the day
    // isolation is enforced (#1557). Same fallback registration uses.
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());

    if ((await verticalFor(orgId)) === 'MARKETING') {
      return convertToLead({ inquiryId: inquiry.id, orgId, session, ownerId: parsed.data.ownerId, request });
    }

    // The invitee has no account and therefore no `preferredLanguage`, so the
    // mail's language is the sender's decision (#1720) — but this sender is
    // answering a form somebody filled in in their own language, and that is
    // better evidence than the admin's UI, so the enquiry's locale wins when it
    // has one.
    const admin = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { preferredLanguage: true },
    });
    const locale = isLocale(inquiry.locale)
      ? inquiry.locale
      : isLocale(admin?.preferredLanguage)
        ? admin.preferredLanguage
        : null;

    const result = await convertInquiryToCompanyAccount({
      inquiryId: inquiry.id,
      actor: { id: session.user.id, email: session.user.email ?? null },
      orgId,
      companyName: parsed.data.companyName ?? inquiry.companyName,
      contactFullName: parsed.data.contactFullName ?? inquiry.contactName,
      email: parsed.data.email ?? inquiry.email,
      industry: parsed.data.industry ?? null,
      size: parsed.data.size ?? null,
      locale,
      request,
    });

    if (!result.ok) {
      const { refusal } = result;
      if (refusal.code === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
      // 409 for the rest: the request was well-formed and the state says no.
      // Each one names what the admin needs in order to do the right thing
      // instead — the company that already holds the address, or the one the
      // live invitation is already for.
      return NextResponse.json({ error: refusal.code, ...refusal }, { status: 409 });
    }

    // No token, no register URL, no password — see the module header.
    return NextResponse.json(
      {
        companyId: result.companyId,
        companyName: result.companyName,
        invitationId: result.invitationId,
        email: result.email,
        emailSent: result.emailSent,
      },
      { status: 201 },
    );
  });
}

/** The MARKETING branch: the request becomes a funnel record (see the header). */
async function convertToLead(input: {
  inquiryId: string;
  orgId: string;
  session: { user: { id: string; email?: string | null; role: string } };
  ownerId?: string;
  request: Request;
}): Promise<NextResponse> {
  const { orgId, session } = input;
  // The same gates the hand-typed lead route asks (#2562): the funnel is the
  // `pipeline` module and the account the `companies` one.
  const denied = (await requireCapability(orgId, 'companies')) ?? (await requireCapability(orgId, 'pipeline'));
  if (denied) return denied;

  let owner = null;
  if (input.ownerId) {
    owner = await findLeadOwner(orgId, input.ownerId);
    if (!owner) return NextResponse.json({ code: 'invalid_owner', error: 'Owner is not an active admin or rep of this organization' }, { status: 400 });
  }
  owner ??= await resolveDefaultLeadOwner(orgId);
  owner ??= { id: session.user.id, email: session.user.email ?? '', orgId, role: session.user.role };

  const outcome = await convertInquiryToMarketingLead({
    inquiryId: input.inquiryId,
    orgId,
    owner,
    actor: { id: session.user.id, email: session.user.email ?? null },
    request: input.request,
  });
  switch (outcome.kind) {
    case 'converted': {
      const company = await prisma.company.findFirst({ where: { id: outcome.companyId, orgId }, select: { name: true } });
      return NextResponse.json(
        {
          kind: 'lead',
          companyId: outcome.companyId,
          companyName: company?.name ?? null,
          leadId: outcome.leadId,
          stage: outcome.stage,
          ownerId: outcome.ownerId,
        },
        { status: 201 },
      );
    }
    case 'not_found':
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    case 'already_converted':
      return NextResponse.json({ error: 'already_converted', code: 'already_converted', companyId: outcome.companyId, companyName: outcome.companyName }, { status: 409 });
    case 'in_progress':
      return NextResponse.json({ error: 'in_progress', code: 'in_progress' }, { status: 409 });
    case 'exists':
      return NextResponse.json({ error: 'account_exists', code: 'account_exists', companyId: outcome.companyId }, { status: 409 });
    case 'contact_in_funnel':
    case 'contact_is_user':
    case 'already_mentored':
      return NextResponse.json({ error: outcome.kind, code: outcome.kind }, { status: 409 });
    case 'ambiguous':
      return NextResponse.json({ error: 'account_ambiguous', code: 'account_ambiguous' }, { status: 409 });
    case 'write_failed':
      console.error('Inquiry → lead conversion failed:', outcome.reason);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    default:
      return NextResponse.json({ error: 'invalid', code: 'invalid', reason: outcome.reason }, { status: 400 });
  }
}
