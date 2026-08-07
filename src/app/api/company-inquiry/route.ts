import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { notify } from '@/lib/notify';
import { sendCompanyInquiryEmail } from '@/services/emailService';

// A company asking for a look at the product, from the public /for-companies
// page. Companies have no self-service sign-up (a COMPANY user is only born
// from an InvitationToken), so this form is the bridge — and the request has to
// survive: it is stored, notified in-app and emailed, because an enquiry that
// only exists in one inbox is an enquiry that gets lost.
//
// Anti-spam follows the proven pattern in /api/public-contact/[userId]: a
// honeypot field, a minimum render-to-submit time and a per-IP rate limit. No
// external captcha — our CSP blocks third-party scripts.
const schema = z.object({
  companyName: z.string().min(1).max(160),
  contactName: z.string().min(1).max(120),
  email: z.string().email().max(200),
  phone: z.string().max(40).optional(),
  openRoles: z.string().max(300).optional(),
  message: z.string().max(TEXT_LIMITS.publicContactMessage).optional(),
  // Consent to the privacy notice. Checked server-side too — a UI-only check is
  // not a consent record (GDPR Art. 7).
  consent: z.boolean(),
  locale: z.string().max(5).optional(),
  // Honeypot — accept any string so a filled value validates and is dropped
  // silently by the handler (a 400 here would leak the trap to bots).
  website: z.string().max(500).optional(),
  // Client-stamped render time (ms epoch) to reject instant/bot submits.
  renderedAt: z.number().int().optional(),
});

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'company-inquiry', { limit: 3, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { companyName, contactName, email, phone, openRoles, message, consent, locale, website, renderedAt } =
    parsed.data;

  if (!consent) return NextResponse.json({ error: 'Consent is required' }, { status: 400 });

  // Honeypot filled, or submitted implausibly fast (<3s) → silently accept
  // (200) so bots get no signal, but drop the enquiry.
  const tooFast = typeof renderedAt === 'number' && Date.now() - renderedAt < 3000;
  if (website || tooFast) return NextResponse.json({ ok: true });

  const inquiry = await prisma.companyInquiry.create({
    data: {
      companyName,
      contactName,
      email,
      phone: phone || null,
      openRoles: openRoles || null,
      message: message || null,
      locale: locale || null,
      consentAt: new Date(),
    },
    select: { id: true },
  });

  // Two more places, so it cannot go unnoticed: every active admin gets an
  // in-app notification pointing at the list, and an email.
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, email: true, fullName: true, preferredLanguage: true, orgId: true },
  });
  await Promise.all(
    admins.map((a) =>
      notify(a.id, 'signup', `Company enquiry from ${companyName} (${contactName}).`, '/admin/company-inquiries')
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
        openRoles: openRoles || null,
        message: message || null,
        locale: a.preferredLanguage,
        orgId: a.orgId,
      });
    } catch (e) {
      // A mail failure must not turn a captured enquiry into a 500 for the
      // sender — the row and the in-app notification already exist.
      console.error('Company inquiry email failed:', e);
    }
  }

  return NextResponse.json({ ok: true, id: inquiry.id });
}
