import { NextResponse } from 'next/server';
import { withApiKey } from '@/lib/apiKey';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveIntegrationSource } from '@/lib/integrationSources';
import { accountEventSchema } from '@/lib/accountEventSchema';
import { ingestAccountEvent } from '@/lib/accountEventIngest';

// POST — one account event from a registered machine source (#2450, one
// generic route since #2914), machine to machine. The public contract is
// docs/integrations/account-events.md.
//
// THE ORDER IS THE SECURITY MODEL:
//   1. the door — withApiKey(request, 'companies:write'): a missing, unknown,
//      expired or revoked key is a 401, a key without the write scope a 403,
//      and the tenant is the key's bound organization, never the request. The
//      slug is not looked at before this, so a caller without a key gets the
//      same 401 for every slug and cannot enumerate them. Rate limited per key
//      inside withApiKey;
//   2. the source — the `[source]` slug resolved INSIDE the key's org
//      (src/lib/integrationSources.ts): unregistered, disabled, malformed,
//      reserved or another tenant's are one and the same 404 `unknown_source`;
//   3. the binding — a source bound to one key refuses every other key of the
//      org with 403 `wrong_source_key`;
//   4. the product — the org's vertical must carry the `companies` capability;
//   5. the envelope, then the writer (src/lib/accountEventIngest.ts).
//
// Outside /api/v1 on purpose (/api/v1 is frozen, #2348 decision 3); listed in
// scripts/check-api-key-routes.mjs. A repeated event_id answers 200 with
// `outcome: duplicate` and writes nothing; `no_default_owner` is a 409 the
// source should retry once the org has a default lead owner.

export async function POST(request: Request, { params }: { params: Promise<{ source: string }> }) {
  return withRequestScope(request, () =>
    withApiKey(request, 'companies:write', async (key) => {
      const source = await resolveIntegrationSource(key.orgId, (await params).source);
      if (!source) {
        return NextResponse.json(
          { code: 'unknown_source', error: 'No integration source with this name is registered for your organization.' },
          { status: 404 },
        );
      }
      if (source.apiKeyId && source.apiKeyId !== key.id) {
        return NextResponse.json(
          { code: 'wrong_source_key', error: 'This integration source accepts events from a different API key.' },
          { status: 403 },
        );
      }

      const gated = await requireCapability(key.orgId, 'companies');
      if (gated) return gated;

      const parsed = accountEventSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: 'Invalid event',
            issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
          { status: 400 },
        );
      }

      const result = await ingestAccountEvent(key.orgId, source, parsed.data);
      if (result.outcome === 'no_default_owner') {
        return NextResponse.json(
          {
            outcome: result.outcome,
            code: 'no_default_owner',
            error: 'This organization has no default lead owner, so a new account has nowhere to land. Set one and retry.',
          },
          { status: 409 },
        );
      }
      return NextResponse.json(result);
    }),
  );
}
