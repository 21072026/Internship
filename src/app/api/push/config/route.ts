import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { vapidPublicKey } from '@/lib/webPush';

// GET — whether this deployment can deliver Web Push, and the VAPID public key
// the browser needs to create a subscription (#1464).
//
// A route rather than a `NEXT_PUBLIC_*` build-time constant on purpose: the
// images here are built on a GitHub runner and the keys only exist as runtime
// env on the server (same reasoning as the JaaS host in next.config.js), so
// inlining the key at build time would ship an empty string to production.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const publicKey = vapidPublicKey();
  return NextResponse.json({ enabled: Boolean(publicKey), publicKey });
}
