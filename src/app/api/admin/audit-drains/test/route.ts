import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { rateLimit } from '@/lib/rateLimit';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { deliverTestBatch } from '@/lib/auditDrain';

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'ADMIN' ? session : null;
}

// "Send a test batch" (#2012): two SYNTHETIC rows, signed like a real batch
// and flagged `X-Audit-Test: 1`, so an integrator proves the receiver and the
// signature before a single real row leaves. Real rows never go through this
// button, and the outcome neither moves the cursor nor counts towards the
// pause ceiling (lib/auditDrain.ts deliverTestBatch).
export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id') || '';
  // Keyed by drain id (the sibling webhooks/test does the same): the budget
  // that matters is how often we knock on a third party's URL.
  const rl = rateLimit(`audit-drain-test:${id}`, { limit: 3, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many test batches for this drain.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }
  // Scoped to the caller's tenant: a test batch to another tenant's receiver
  // would deliver a signed request to a URL you don't own and confirm it exists.
  const drain = await prisma.auditDrain.findFirst({
    where: { id, orgId: await settingsOrgOf(session) },
    select: { id: true, orgId: true, url: true, secret: true, format: true },
  });
  if (!drain) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const result = await deliverTestBatch(drain);
  // 200 either way — the API call succeeded; whether the receiver did is the
  // payload, rendered inline by the console. No activity row: a diagnostic.
  return NextResponse.json(result);
}
