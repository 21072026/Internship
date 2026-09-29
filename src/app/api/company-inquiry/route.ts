import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { MARKETING_OPT_IN_TEXT_VERSION, PRIVACY_POLICY_VERSION } from '@/lib/privacy';
import { requestHostHeader, resolvePublicInquiryTarget } from '@/lib/publicHostOrg';
import { readInquiryAttribution } from '@/lib/inquiryAttribution';
import { resolveDefaultLeadOwner } from '@/lib/leadOwner';
import { convertInquiryToMarketingLead } from '@/lib/inquiryLead';
import { enforceRateLimit } from '@/lib/rateLimit';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { notify } from '@/lib/notify';
import { orgWhere } from '@/lib/tenantFilter';
import { sendCompanyInquiryEmail } from '@/services/emailService';

// A company asking for a look at the product — from the public /for-companies
// page on an internship host, or the demo form on the MARKETING landing (#2569).
// Companies have no self-service sign-up (a COMPANY user is only born from an
// InvitationToken), so this form is the bridge — and the request has to
// survive: it is stored, notified in-app and emailed, because an enquiry that
// only exists in one inbox is an enquiry that gets lost.
//
// Anti-spam follows the proven pattern in /api/public-contact/[userId]: a
// honeypot field, a minimum render-to-submit time and a per-IP rate limit. No
// external captcha — our CSP blocks third-party scripts.
const utmValue = z.string().max(300).optional();

const schema = z.object({
  companyName: z.string().min(1).max(160),
  contactName: z.string().min(1).max(120),
  email: z.string().email().max(TEXT_LIMITS.companyContactEmail),
  phone: z.string().max(40).optional(),
  openRoles: z.string().max(300).optional(),
  // MARKETING form (#2569): the marketplaces they sell on, free text. Ignored
  // on an internship host, like `openRoles` is ignored on a marketing one.
  marketplaces: z.string().max(300).optional(),
  message: z.string().max(TEXT_LIMITS.publicContactMessage).optional(),
  // Consent to the privacy notice. Checked server-side too — a UI-only check is
  // not a consent record (GDPR Art. 7).
  consent: z.boolean(),
  // The SEPARATE product-news box (MARKETING form only), unchecked by default.
  // Stored as an unconfirmed REQUEST (#2569): a single opt-in from a public form
  // is no permission to mail anyone (UWG §7(2) Nr. 2) until double opt-in; the
  // consent model it may one day feed is #2577.
  marketingOptIn: z.boolean().optional(),
  locale: z.string().max(5).optional(),
  // Where they came from (#2569). Cleaned and capped by readInquiryAttribution
  // (src/lib/inquiryAttribution.ts); these bounds only refuse absurd bodies.
  utm: z
    .object({ source: utmValue, medium: utmValue, campaign: utmValue, term: utmValue, content: utmValue })
    .optional(),
  referrer: z.string().max(2000).optional(),
  // Honeypot — accept any string so a filled value validates and is dropped
  // silently by the handler (a 400 here would leak the trap to bots).
  website: z.string().max(500).optional(),
  // Client-stamped render time (ms epoch) to reject instant/bot submits.
  renderedAt: z.number().int().optional(),
});

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'company-inquiry', { limit: 3, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;

  // WHICH TENANT A PUBLIC ENQUIRY BELONGS TO (#1559, #2569).
  //
  // This form has no session, so nothing binds a tenant context and the
  // middleware injects nothing here — `CompanyInquiry` being registered in
  // TENANT_MODELS changes reads, not this create. The org is decided here, from
  // the host the request arrived on, by ONE explicit rule
  // (src/lib/publicHostRule.ts): the org whose `publicHost` is exactly this
  // hostname; else, on an internship host, the default org (what this line
  // always did, and what /api/register does for an uninvited sign-up); else —
  // a marketing host no org claims — the form is CLOSED. Never "the first
  // MARKETING org": a heuristic that picks a tenant is how a stranger's demo
  // request lands in the wrong company's inbox. The trust reasoning for reading
  // the host here is in src/lib/publicHostOrg.ts and src/lib/hostVertical.ts.
  //
  // Decided before the body is read, so a closed form answers the same 503
  // whatever is posted to it.
  const target = await resolvePublicInquiryTarget(requestHostHeader(request.headers));
  if (!target.open) {
    return NextResponse.json(
      { code: 'form_unavailable', error: 'This form is not available right now.' },
      { status: 503 },
    );
  }
  const orgId = target.orgId;
  const isMarketing = target.vertical === 'MARKETING';

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { companyName, contactName, email, phone, message, consent, locale, website, renderedAt } = parsed.data;
  // Each vertical keeps only the field its own form shows.
  const openRoles = isMarketing ? null : parsed.data.openRoles || null;
  const marketplaces = isMarketing ? parsed.data.marketplaces?.trim() || null : null;

  if (!consent) return NextResponse.json({ error: 'Consent is required' }, { status: 400 });

  // Honeypot filled, or submitted implausibly fast (<3s) → silently accept
  // (200) so bots get no signal, but drop the enquiry.
  const tooFast = typeof renderedAt === 'number' && Date.now() - renderedAt < 3000;
  if (website || tooFast) return NextResponse.json({ ok: true });

  // Deliberately never NULL as a super-admin triage queue: the admin list
  // (/api/admin/company-inquiries) filters by the caller's tenant, so a NULL-org
  // row would disappear from the only screen that shows it — the "row left at
  // orgId = NULL vanishes from the product" failure docs/tenant-isolation.md
  // warns about. `target.orgId` is the mapped org or the default org.
  const attribution = readInquiryAttribution({ utm: parsed.data.utm, referrer: parsed.data.referrer }, target.host);
  // NULL where the form never asked (internship), the ticked value where it did.
  const optInRequested = isMarketing ? parsed.data.marketingOptIn === true : null;
  const inquiry = await prisma.companyInquiry.create({
    data: {
      orgId,
      companyName,
      contactName,
      email,
      phone: phone || null,
      openRoles,
      marketplaces,
      message: message || null,
      locale: locale || null,
      // The consent record (#2569): when, and WHICH privacy text — both from the
      // server, never from the body. No IP is stored.
      consentAt: new Date(),
      consentTextVersion: PRIVACY_POLICY_VERSION,
      // A request, not a permission — `marketingOptInConfirmedAt` stays NULL
      // (no double opt-in exists). The wording version is stamped separately
      // from the privacy version; the language it was shown in is `locale`.
      marketingOptInRequested: optInRequested,
      marketingOptInTextVersion: optInRequested ? MARKETING_OPT_IN_TEXT_VERSION : null,
      // A Host header is not length-bounded by anything upstream of us.
      receivedHost: target.host ? target.host.slice(0, 191) : null,
      ...attribution,
    },
    select: { id: true },
  });

  // A MARKETING request with a default owner (#2580) goes straight onto that
  // person's funnel at the first stage, through the same writer an admin's
  // "convert" uses. Without one — or if the writer refuses (an account of that
  // name already exists, the contact is already somebody's lead) — the enquiry
  // stays NEW in /admin/company-inquiries, labelled unowned, for an admin to
  // place. It is never dropped, and a failure here never turns a captured
  // enquiry into an error for the sender.
  if (isMarketing && orgId) {
    try {
      const owner = await resolveDefaultLeadOwner(orgId);
      if (owner) {
        // No `request`: the public visitor's IP must not reach the activity log
        // (the privacy notice promises this form stores none).
        await convertInquiryToMarketingLead({ inquiryId: inquiry.id, orgId, owner, actor: null });
      }
    } catch (e) {
      console.error('Company inquiry lead placement failed:', e);
    }
  }

  // Two more places, so it cannot go unnoticed: the TARGET ORG'S active admins
  // get an in-app notification pointing at the list, and an email. Only that
  // org's — the query used to have no org filter at all, so every tenant's
  // admins were told about every other tenant's enquiries (#2569). On the
  // default org a NULL-org admin counts as the default org's, the same rule
  // tenantWhere() applies — decided by WHICH org it is (orgWhere, same file),
  // not by how it was resolved, so an explicit mapping of a host to the default
  // org notifies exactly the admins whose list shows the row.
  // (No org at all only when no default org exists yet: then the row is
  // NULL-org, and so are the admins who will see it.)
  const adminOrgWhere = orgId ? await orgWhere(orgId) : { orgId: null };
  const admins = await prisma.user.findMany({
    where: { AND: [{ role: 'ADMIN', isActive: true }, adminOrgWhere] },
    select: { id: true, email: true, fullName: true, preferredLanguage: true, orgId: true },
  });
  await Promise.all(
    admins.map((a) =>
      notify(a.id, 'signup.companyInquiry', { companyName, contactName }, '/admin/company-inquiries')
    )
  );
  for (const a of admins) {
    if (!a.email) continue;
    try {
      await sendCompanyInquiryEmail({
        to: a.email,
        adminName: a.fullName,
        companyName,
        contactName,
        fromEmail: email,
        phone: phone || null,
        openRoles,
        marketplaces,
        message: message || null,
        locale: a.preferredLanguage,
        orgId: a.orgId ?? orgId,
        // The admin being written to on this iteration. `email` / `contactName`
        // are the enquiring company's, from an unauthenticated public form.
        // No call-site preference check exists here and the select deliberately
        // stays narrow (no notificationPrefs): sendEmail() reads the preferences
        // itself from this id, so the inbound_requests opt-out is honoured
        // without a second query per admin in this route.
        userId: a.id,
      });
    } catch (e) {
      // A mail failure must not turn a captured enquiry into a 500 for the
      // sender — the row and the in-app notification already exist.
      console.error('Company inquiry email failed:', e);
    }
  }

  // The SAME body as the honeypot drop above, and nothing that depends on what
  // the tenant already holds: whether the writer placed it (it refuses when the
  // e-mail is a staff member's or already somebody's lead, or the company name
  // is an existing account) would let an anonymous caller probe the tenant's
  // staff, leads and customers one POST at a time (#2569 review). The sender
  // learns only that the request was received.
  return NextResponse.json({ ok: true });
}
