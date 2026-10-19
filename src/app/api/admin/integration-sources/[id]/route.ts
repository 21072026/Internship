import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { patchSource, sourceFor } from '@/lib/integrationSourceAdmin';
import { SOURCE_ALLOWLIST_TEXT_MAX } from '@/lib/sourceIpAllowlistRule';

// PATCH — switch a registered integration source on or off, or set / clear its
// IP allowlist (#2978). The ADMIN of the source's org or a super admin of its
// world; another org's source is the same 404 as a missing one. Every change
// writes an AuditLog row with the source's orgId. An invalid allowlist is a 400
// `invalid_allowed_ips` naming each refused entry, and nothing is stored.
const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedIps: z
      .union([z.string().max(SOURCE_ALLOWLIST_TEXT_MAX), z.array(z.string().max(100)).max(200), z.null()])
      .optional(),
  })
  .strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const gate = await sourceFor(session, (await params).id);
  if (!gate.ok) return gate.response;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }
  const result = await patchSource(session, gate.value, parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: 'Invalid allowed IPs', code: result.code, errors: result.errors }, { status: 400 });
  }
  return NextResponse.json({ source: result.source });
}
