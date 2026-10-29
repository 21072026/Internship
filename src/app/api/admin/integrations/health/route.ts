import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { getIntegrationHealth } from '@/lib/integrationHealth';
import { resolveOrgId } from '@/lib/orgScope';

// GET — per-connector integration health for an admin (#2008). The admin
// integrations board renders this, and /admin/operations (#1607) counts the
// per-connector `state` values for its roll-up, so the response shape is a
// contract: one entry per connector, in a fixed order, with a machine-countable
// `state` rather than prose. Every error string is already scrubbed of
// addresses, tokens and certificate bodies by lib/sanitizeError.
//
// Tenant-owned rows are read for the caller's own org (#1555), taken from the
// session — never from the request.
//
// The ADMIN check lives here in the handler — the board is a client component,
// so a check up there would gate the rendering and not the data.
export async function GET(request: Request) {
  const gate = await requirePermission('org.integrations.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return NextResponse.json({ connectors: await getIntegrationHealth(resolveOrgId(session)) });
}
