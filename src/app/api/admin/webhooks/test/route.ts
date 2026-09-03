import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { rateLimit } from '@/lib/rateLimit';
import { deliverToWebhook } from '@/lib/webhooks';

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'ADMIN' ? session : null;
}

// Send a signed `ping` to one webhook and report the receiver's answer.
// It goes through the normal delivery path, so an integrator can prove their
// signature verification works before their first real event arrives.
export async function POST(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id') || '';
  // Keyed by hook id, not by client IP: the receiver is a third party and every
  // admin shares one production host, so the budget that matters is "how often
  // may we knock on this URL", not "how often may this admin click".
  const rl = rateLimit(`webhook-test:${id}`, { limit: 3, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many test pings for this webhook.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  const hook = await prisma.webhook.findUnique({ where: { id } });
  if (!hook) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const { status, ms } = await deliverToWebhook(hook, 'ping', { hookId: hook.id, test: true });
    return NextResponse.json({ ok: true, status, ms });
  } catch (e) {
    // 200 with ok:false — the API call succeeded, the receiver did not, and the
    // UI renders that difference inline. No activity row either way: a ping is
    // a read-shaped diagnostic that would flood the log at 3/min/hook.
    return NextResponse.json({ ok: false, error: String(e) });
  }
}
