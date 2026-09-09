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

// Convert an inbound enquiry into a Company plus an invited COMPANY login, in
// one action (#1863). The mechanics — and the reasoning about ordering,
// idempotence and what is never returned — live in
// src/lib/companyProvisioning.ts; this handler is authorisation, validation and
// the HTTP shape only.
//
// The fields are prefilled from the enquiry on the client and editable before
// submit, because what a company types into a public form ("acme", "info@…") is
// not necessarily what the record should say.
const convertSchema = z.object({
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

    const inquiry = await prisma.companyInquiry.findUnique({
      where: { id },
      select: { id: true, companyName: true, contactName: true, email: true, locale: true },
    });
    if (!inquiry) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Never null: an admin whose account predates the org backfill would
    // otherwise create a Company and an invitation that both disappear the day
    // isolation is enforced (#1557). Same fallback registration uses.
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());

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
      // 409 for both: the request was well-formed and the state says no. Each
      // one names what the admin needs in order to do the right thing instead.
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
