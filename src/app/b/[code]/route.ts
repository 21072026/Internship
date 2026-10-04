import { CAMPAIGN_CODE_RE, campaignLandingPath } from '@/lib/postCampaignRule';

/**
 * The short link printed on a postal-campaign letter (#2697): `/b/<code>` —
 * short enough to type off paper — sends the reader to the landing's demo form
 * with the letter as the source (`utm_source=brief&utm_medium=post`), so a
 * request that follows is attributed to the campaign (src/lib/leadSourceName.ts).
 *
 * Public on purpose: the reader has no account. It reads nothing and writes
 * nothing — no lookup of the code either, so it cannot be used to discover
 * which campaigns exist; an unknown code just lands as an unknown campaign.
 * The Location is RELATIVE: it stays on whichever host the letter named
 * (src/lib/servedHosts.ts).
 */
export function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  return params.then(({ code }) => {
    const clean = code.toLowerCase();
    const location = CAMPAIGN_CODE_RE.test(clean) ? campaignLandingPath(clean) : '/';
    return new Response(null, { status: 307, headers: { Location: location, 'Cache-Control': 'no-store' } });
  });
}
