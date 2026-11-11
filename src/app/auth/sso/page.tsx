import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requestHostHeader } from '@/lib/publicHostOrg';
import { discoverSsoForHost } from '@/lib/ssoDiscovery';
import { SsoStartClient } from './SsoStartClient';

// Enterprise SSO entry (#545). On a tenant's own verified host (#1665) the
// host already names the organisation, so the code prompt is skipped and the
// browser goes straight to that tenant's login route. Everywhere else — the
// default host, an unverified domain, a tenant whose SSO is off — the manual
// code form stays, so there is no dead end.
export default async function SsoStartPage() {
  const tenantSso = await discoverSsoForHost(requestHostHeader(await headers()));
  if (tenantSso) redirect(`/api/auth/sso/${encodeURIComponent(tenantSso.slug)}/login`);
  return <SsoStartClient />;
}
