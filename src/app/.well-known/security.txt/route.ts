import { operatorIdentityForRequest } from '@/lib/imprintRequest';
import { buildSecurityTxt, securityContactEmail } from '@/lib/securityTxt';

// /.well-known/security.txt (RFC 9116, #2031). Dynamic because the operator
// contact comes from the deployment's env and follows the host's world
// (src/lib/securityTxt.ts says why it is not a static file any more).
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const operator = await operatorIdentityForRequest();
  const body = buildSecurityTxt(securityContactEmail(process.env, operator?.email));
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
