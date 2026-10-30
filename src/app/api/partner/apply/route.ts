import { NextResponse, after } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requestHostHeader } from '@/lib/publicHostOrg';
import { affiliateProgrammeForHost } from '@/lib/affiliatePublicPage';
import { parseAffiliateApplication } from '@/lib/affiliateApplicationRule';
import { submitAffiliateApplication } from '@/lib/affiliateApplications';
import { isLocale } from '@/i18n/config';

// POST — a partner application from the public form on /partner/apply
// (docs/affiliate-module.md, #3361). Sessionless by design: nobody gets an
// account here, an admin decides (#3362).
//
// The org is the one this HOST's programme belongs to (affiliateProgrammeForHost:
// the operator's host mapping, MARKETING, `affiliate` capability, a valid plan);
// without one the form is closed (503), decided before the body is read.
// Anti-spam follows /api/company-inquiry: a per-IP limit, a honeypot and a
// minimum render-to-submit time, plus a per-address cap in the writer. The tight
// limit (3/hour) is spent only by a VALID body, so a person correcting a typo is
// not locked out; a loose one (30/hour) bounds everything else. Every accepted
// body answers the same 200 in the same time — notices and mail run after the
// response (`after()`), whatever happened to it.
export async function POST(request: Request) {
  const flooded = enforceRateLimit(request, 'affiliate-application-any', { limit: 30, windowMs: 60 * 60 * 1000 });
  if (flooded) return flooded;

  const programme = await affiliateProgrammeForHost(requestHostHeader(request.headers));
  if (!programme) return NextResponse.json({ code: 'form_unavailable' }, { status: 503 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseAffiliateApplication(body);
  if (!parsed.ok) return NextResponse.json({ code: 'invalid_application', fields: parsed.fields }, { status: 400 });
  const limited = enforceRateLimit(request, 'affiliate-application', { limit: 3, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;

  const extra = body as { website?: unknown; renderedAt?: unknown; locale?: unknown };
  // Honeypot filled, or submitted implausibly fast (<3s): accepted silently and dropped.
  const tooFast = typeof extra.renderedAt === 'number' && Date.now() - extra.renderedAt < 3000;
  if ((typeof extra.website === 'string' && extra.website !== '') || tooFast) return NextResponse.json({ ok: true });

  const locale = typeof extra.locale === 'string' && isLocale(extra.locale) ? extra.locale : null;
  const { followUp } = await submitAffiliateApplication({ orgId: programme.orgId, application: parsed.application, locale });
  if (followUp) after(followUp);
  return NextResponse.json({ ok: true });
}
