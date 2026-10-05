import { headers } from 'next/headers';
import { worldForHeaders } from '@/lib/hostWorld';
import { operatorIdentity, type OperatorIdentity } from '@/lib/imprint';

/**
 * The operator for the host this request came in on — the server-component
 * entry point of `operatorIdentity` (#2697). The host only chooses WHICH
 * configured identity is shown; it never supplies one. Kept apart from
 * src/lib/imprint.ts so that file stays pure and unit-testable.
 */
export async function operatorIdentityForRequest(): Promise<OperatorIdentity | null> {
  const bag = await headers();
  return operatorIdentity(process.env, worldForHeaders((name) => bag.get(name)));
}
