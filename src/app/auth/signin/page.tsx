import { IS_DEMO_MODE, DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/lib/demoMode';
import { SignInClient } from './SignInClient';

// Server wrapper: IS_DEMO_MODE is a server-only env flag (deliberately not
// NEXT_PUBLIC_), so the demo quick-login accounts are resolved here and handed
// to the client form as a prop. On every non-demo instance the prop is null
// and the sign-in page renders exactly as before.
export default function SignInPage() {
  return (
    <SignInClient
      demo={
        IS_DEMO_MODE
          ? { accounts: DEMO_ACCOUNTS.map((a) => ({ ...a })), password: DEMO_PASSWORD }
          : null
      }
    />
  );
}
