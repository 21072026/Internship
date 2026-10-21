import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { klaviyoAdminGate } from '@/lib/klaviyoGate';
import { checkKlaviyoKey } from '@/lib/klaviyoRule';
import { savedKlaviyoKey, testKlaviyoKey } from '@/lib/klaviyoSync';

// "Test connection": ONE read-only call (one profile) with the pasted key, or
// with the saved one when the body names none. Answers a code, never anything
// the provider sent back.

const bodySchema = z.object({ key: z.string().max(300).optional() });

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const g = await klaviyoAdminGate(session);
    if (!g.ok) return g.response;
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ ok: false, code: 'empty' }, { status: 400 });
    let key: string | null;
    if (parsed.data.key !== undefined && parsed.data.key.trim()) {
      const checked = checkKlaviyoKey(parsed.data.key);
      if (!checked.ok) return NextResponse.json({ ok: false, code: checked.code }, { status: 400 });
      key = checked.key;
    } else {
      key = await savedKlaviyoKey(g.orgId);
      if (!key) return NextResponse.json({ ok: false, code: 'not_connected' }, { status: 400 });
    }
    const result = await testKlaviyoKey(key);
    if (!result.ok) return NextResponse.json({ ok: false, code: result.code });
    return NextResponse.json({ ok: true });
  });
}
