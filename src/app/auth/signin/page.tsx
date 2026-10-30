import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/pageMetadata';
import { IS_DEMO_MODE, DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/lib/demoMode';
import { headers } from 'next/headers';
import { requestHostHeader } from '@/lib/publicHostOrg';
import { discoverSsoForHost } from '@/lib/ssoDiscovery';
import { SignInClient } from './SignInClient';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata((t) => ({ title: t.seo.signInTitle, description: t.seo.signInDescription }));
}

// Server wrapper: IS_DEMO_MODE is a server-only env flag (deliberately not
// NEXT_PUBLIC_), so the demo quick-login accounts are resolved here and handed
// to the client form as a prop. On every non-demo instance the prop is null
// and the sign-in page renders exactly as before.
//
// Per-tenant SSO discovery (#1665): on a tenant's own verified host the page
// leads with "Continue with <tenant> SSO". On the default host this is null and
// nothing changes.
export default async function SignInPage() {
  const tenantSso = await discoverSsoForHost(requestHostHeader(await headers()));
  return (
    <SignInClient
      tenantSso={tenantSso}
      demo={
        IS_DEMO_MODE
          ? { accounts: DEMO_ACCOUNTS.map((a) => ({ ...a })), password: DEMO_PASSWORD }
          : null
      }
    />
  );
}
