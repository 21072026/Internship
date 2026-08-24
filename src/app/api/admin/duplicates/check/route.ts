import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { findPossibleDuplicates } from '@/lib/duplicateDetection';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';

const bodySchema = z.object({
  fullName: z.string().min(2),
  email: z.string().optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  university: z.string().optional(),
  // Set when checking an EXISTING record (edit forms) so it never matches itself.
  excludeId: z.string().optional(),
});

// POST — pre-flight duplicate check for the candidate creation/edit forms
// (#841). Mentors need it too: their "add mentee" form runs this before
// creating. Report-only — never blocks, never mutates.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }

    const matches = await findPossibleDuplicates({ ...parsed.data, orgId: resolveOrgId(session) });
    return NextResponse.json({ matches });
  });
}
