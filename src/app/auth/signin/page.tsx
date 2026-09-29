import { IS_DEMO_MODE, DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/lib/demoMode';
import { worldOrigins } from '@/lib/hostWorld';
import { SignInClient } from './SignInClient';

// Read per request, never prerendered: the origins below come from
// MARKETING_HOSTS / NEXT_PUBLIC_APP_URL, and the first is a RUNTIME variable
// (preview sets a different marketing host than prod). A page frozen at build
// time would send a preview visitor to the production marketing domain.
export const dynamic = 'force-dynamic';

// Server wrapper: IS_DEMO_MODE is a server-only env flag (deliberately not
// NEXT_PUBLIC_), so the demo quick-login accounts are resolved here and handed
// to the client form as a prop. On every non-demo instance the prop is null
// and the sign-in page renders exactly as before.
//
// The same reasoning covers `worldOrigins` (#2590, docs/worlds.md): one person can
// hold an account in each product, and a sign-in that reaches the wrong door
// answers "this account lives on the other site" — the client turns that into a
// link, but only the server knows where the other site is.
export default function SignInPage() {
  return (
    <SignInClient
      demo={
        IS_DEMO_MODE
          ? { accounts: DEMO_ACCOUNTS.map((a) => ({ ...a })), password: DEMO_PASSWORD }
          : null
      }
      worldOrigins={worldOrigins()}
    />
  );
}
