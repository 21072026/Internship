import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { orgWhere } from '@/lib/tenantFilter';
import { requestHostHeader, resolvePublicInquiryTarget } from '@/lib/publicHostOrg';
import { checkSignupEmail, looksAutomated } from '@/lib/companySignup';
import { provisionSelfSignupCompany } from '@/lib/companyProvisioning';
import { notifyEvent } from '@/lib/notifications/router';

// POST /api/public/signup/company (#1865, docs/company-verification.md) — an
// employer registers itself, unauthenticated.
//
// What it creates is deliberately harmless until a person (or a domain proof)
// vouches for it: a PENDING company, which reaches no candidate, and an
// invitation to its first COMPANY login, mailed to the work address — the
// set-password link. The link is NEVER in the response (#987): it is a live
// credential.
//
// Anti-abuse, the company-inquiry pattern: a per-IP rate limit, a honeypot and
// a minimum render-to-submit time (both answered with the ordinary 202, so a
// bot learns nothing), free-mail domains refused. And the response is the same
// 202 whether the address is new, already has an account or already holds an
// invitation, so the form cannot be used to probe who is a customer.
//
// INTERNSHIP hosts only: the tenant comes from the host, by the same rule as the
// enquiry form (src/lib/publicHostOrg.ts); a MARKETING host is closed (503).

const schema = z.object({
  companyName: z.string().trim().min(1).max(TEXT_LIMITS.companyName),
  contactName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(TEXT_LIMITS.companyContactEmail),
  industry: z.string().trim().max(TEXT_LIMITS.companyIndustry).optional(),
  size: z.string().trim().max(TEXT_LIMITS.companySize).optional(),
  // Consent to the terms and privacy notice — checked here, a UI-only check is no record.
  consent: z.boolean(),
  locale: z.string().max(5).optional(),
  // Honeypot: any string validates, a filled one is dropped silently.
  website: z.string().max(500).optional(),
  renderedAt: z.number().int().optional(),
});

const ACCEPTED = { ok: true, code: 'check_inbox' } as const;

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'company-signup', { limit: 5, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;

  const target = await resolvePublicInquiryTarget(requestHostHeader(request.headers));
  if (!target.open || target.vertical !== 'INTERNSHIP' || !target.orgId) {
    return NextResponse.json({ code: 'form_unavailable', error: 'This form is not available right now.' }, { status: 503 });
  }
  const orgId = target.orgId;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });
  const data = parsed.data;
  if (!data.consent) return NextResponse.json({ error: 'Consent is required', code: 'consent_required' }, { status: 400 });
  if (looksAutomated({ honeypot: data.website, renderedAt: data.renderedAt, now: Date.now() })) {
    return NextResponse.json(ACCEPTED, { status: 202 });
  }
  const address = checkSignupEmail(data.email);
  if (!address.ok) return NextResponse.json({ error: 'Use your work e-mail address', code: address.code }, { status: 400 });

  const result = await provisionSelfSignupCompany({
    orgId,
    companyName: data.companyName,
    contactFullName: data.contactName,
    email: data.email,
    domain: address.domain,
    industry: data.industry,
    size: data.size,
    locale: data.locale ?? null,
    request,
  });
  // A taken address or a live invitation answers exactly like success.
  if (!result.ok) return NextResponse.json(ACCEPTED, { status: 202 });

  // The org's admins hear about it in-app and by mail: a PENDING employer waits
  // on them. Only this org's (the enquiry route's rule).
  const admins = await prisma.user.findMany({
    where: { AND: [{ role: 'ADMIN', isActive: true }, await orgWhere(orgId)] },
    select: { id: true },
  });
  if (admins.length) {
    await notifyEvent(admins.map((a) => a.id), 'signup.companySelf', { companyName: result.companyName, domain: address.domain });
  }

  return NextResponse.json(ACCEPTED, { status: 202 });
}
