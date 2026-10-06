// The INTEGRATIONS_API gate for the admin screens that SET UP an integration
// (#1744): creating or re-pointing a webhook and issuing a key that can read
// the public API. The API itself is gated at its one door (withApiKey,
// src/lib/apiKey.ts); this is the other half, so nobody configures what their
// plan will not serve.
//
// What is deliberately NOT gated: deactivating or deleting a webhook, revoking
// a key, rotating a secret — taking an integration down must always work —
// and the delivery of existing webhooks, which keep firing after a downgrade
// rather than silently disappearing.
import type { Session } from 'next-auth';
import { NextResponse } from 'next/server';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';

/** null when the caller's org has INTEGRATIONS_API, else the 403 to return. */
export async function integrationsLocked(session: Session): Promise<NextResponse | null> {
  if (await entitled(await settingsOrgOf(session), 'INTEGRATIONS_API')) return null;
  return NextResponse.json(
    { error: 'Your plan does not include API access and webhooks', code: 'feature_locked', feature: 'INTEGRATIONS_API' },
    { status: 403 },
  );
}
