import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/capabilityGate';
import { NEWSLETTER_TEMPLATES } from '@/lib/newsletterContent';
import { requirePermission } from '@/lib/authz';

// GET — the curated library (src/lib/newsletterContent.ts), all three languages
// of every entry.
//
// Served over the wire rather than imported by the composer: the library is
// ~40 KB of prose in three languages, and importing it into a client component
// would put all of it in the bundle of a page that most admins open a few times
// a year. It is also admin-only content — the picker is the only reader.
export async function GET(request: Request) {
  const gate = await requirePermission('content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;

  return NextResponse.json({ templates: NEWSLETTER_TEMPLATES });
}
