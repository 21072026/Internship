import { after } from 'next/server';
import { clientIp } from '@/lib/clientIp';
import { requestHostHeader } from '@/lib/publicHostOrg';
import { clickRedirectTarget, isCountableRequest, CLICK_CODE_RE } from '@/lib/affiliateClickRule';
import { clickProgrammeForHost, recordAffiliateClickQuietly } from '@/lib/affiliateClicks';

// GET /r/<code> — a partner's tracked link (docs/affiliate-module.md § Link
// clicks, #3541). Sessionless. Every visitor is redirected (302), never shown
// an error: to the programme's referral URL with `ref=<code>` set, to the bare
// referral URL for a malformed code, or to this host's home page when no
// programme or referral URL answers here. The target comes only from the
// settings (`clickRedirectTarget`), never from the request.
//
// The click is counted after the response (`after()`), only for an ACTIVE
// partner of the host's org, only for a countable request (GET, no prefetch,
// not a bot) and only under the per-visitor limit — over it the visitor is
// still redirected. Nothing about the visitor is stored (src/lib/affiliateClicks.ts).
export const dynamic = 'force-dynamic';

function redirect(location: string): Response {
  // no-store: a cached redirect would skip the counter on the next click.
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const programme = await clickProgrammeForHost(requestHostHeader(request.headers)).catch(() => null);
  const target = programme ? clickRedirectTarget(programme.referralUrl, code) : null;
  if (!programme || !target) return redirect('/');

  const userAgent = request.headers.get('user-agent');
  const countable =
    CLICK_CODE_RE.test(code) &&
    isCountableRequest({
      method: request.method,
      userAgent,
      purpose: request.headers.get('sec-purpose') ?? request.headers.get('purpose'),
    });
  if (countable) {
    const input = { orgId: programme.orgId, code, ip: clientIp(request), userAgent: userAgent ?? '' };
    after(() => recordAffiliateClickQuietly(input));
  }
  return redirect(target);
}
