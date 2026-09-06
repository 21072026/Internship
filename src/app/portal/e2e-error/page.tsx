import { throwForE2E } from '@/lib/e2eErrorRoute';

// 404 unless E2E_ERROR_ROUTES=1 — see lib/e2eErrorRoute.ts.
export const dynamic = 'force-dynamic';

export default async function PortalForcedError() {
  return throwForE2E('portal');
}
