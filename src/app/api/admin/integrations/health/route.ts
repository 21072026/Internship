import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIntegrationHealth } from '@/lib/integrationHealth';

// GET — per-connector integration health for an admin (#2008). The admin
// integrations board renders this, and /admin/operations (#1607) counts the
// per-connector `state` values for its roll-up, so the response shape is a
// contract: one entry per connector, in a fixed order, with a machine-countable
// `state` rather than prose. Every error string is already scrubbed of
// addresses, tokens and certificate bodies by lib/sanitizeError.
//
// The ADMIN check lives here in the handler — the board is a client component,
// so a check up there would gate the rendering and not the data.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ connectors: await getIntegrationHealth() });
}
