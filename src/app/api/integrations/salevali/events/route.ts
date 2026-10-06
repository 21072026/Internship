import { NextResponse } from 'next/server';
import { withApiKey } from '@/lib/apiKey';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { saleValiEventSchema } from '@/lib/salevaliIngestSchema';
import { ingestSaleValiEvent } from '@/lib/salevaliIngest';

// POST — one SaleVali account event (#2450), machine to machine.
//
// The door is withApiKey(request, 'companies:write'): a missing, unknown,
// expired or revoked key is a 401, a key without the write scope a 403, and the
// tenant is the key's bound organization — never the request. Rate limited per
// key inside withApiKey. Outside /api/v1 on purpose (/api/v1 is frozen, #2348
// decision 3); listed in scripts/check-api-key-routes.mjs.
//
// The body is the contract's event envelope
// (docs/marketing-vertical/salevali-provider-contract.md § Olay zarfı). What
// it does is src/lib/salevaliIngest.ts. A repeated event_id answers 200 with
// `outcome: duplicate` and writes nothing; `no_default_owner` is a 409 the
// source should retry once the org has a default lead owner.

export async function POST(request: Request) {
  return withRequestScope(request, () =>
    withApiKey(request, 'companies:write', async (key) => {
      const gated = await requireCapability(key.orgId, 'companies');
      if (gated) return gated;

      const parsed = saleValiEventSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: 'Invalid event',
            issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
          { status: 400 },
        );
      }

      const result = await ingestSaleValiEvent(key.orgId, parsed.data);
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
