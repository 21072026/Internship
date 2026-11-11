import { NextResponse } from 'next/server';
import { requireRoleOrPermission } from '@/lib/authz';
import { listTermsKeys } from '@/lib/contributorTerms';

// The terms documents a project can be pointed at (#1026). Names and version
// numbers only — the bodies are public at /contributor-terms, and a picker has
// no use for them. Restricted to the roles that can own a project.
export async function GET(request: Request) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'content.read', { request });
  if ('error' in gate) return gate.error;
  return NextResponse.json({ keys: await listTermsKeys() });
}
