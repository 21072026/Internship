import { assetLinksFor } from '@/lib/androidAppLinks';
import { hostVertical } from '@/lib/hostVertical';

// /.well-known/assetlinks.json — the site's half of the Android Trusted Web
// Activity handshake (docs/mobile-strategy.md, #2085). Per host, like the
// manifest: interncrm.com vouches for the InternshipCRM app, the marketing host
// for SaleVali. The verifier fetches it without cookies, so the host is the
// only signal, and `[]` (no fingerprint yet) is a valid "no association".
//
// Dynamic because the answer follows the Host header.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const statements = assetLinksFor(await hostVertical());
  return new Response(JSON.stringify(statements), {
    headers: {
      // Google's verifier requires application/json and no redirect.
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  });
}
