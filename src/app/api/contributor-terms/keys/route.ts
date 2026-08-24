import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { listTermsKeys } from '@/lib/contributorTerms';

// The terms documents a project can be pointed at (#1026). Names and version
// numbers only — the bodies are public at /contributor-terms, and a picker has
// no use for them. Restricted to the roles that can own a project.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ keys: await listTermsKeys() });
}
