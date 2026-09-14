import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { jaasAllowanceStatus } from '@/lib/jaasAllowance';

// GET — "18 / 25 monthly active participants" for an operator (#2011).
//
// The number is ours: it is counted from the JaaS webhook feed we already
// receive, not scraped from 8x8's dashboard, so the tier decision ("is the free
// allowance actually the constraint?") can be made from evidence in the product
// rather than from a guess encoded in a routing rule.
//
// It carries no identities — `jaasAllowanceStatus` returns four numbers and two
// booleans, and the table behind it holds keyed hashes with no name and no
// join to a User. Nothing here gates anything either: video is free-core, and
// the allowance only decides WHICH host a room is on, never whether it exists.
//
// The ADMIN check is in the handler because the integrations board is a client
// component — a check up there would gate the rendering, not the data.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await jaasAllowanceStatus());
}
