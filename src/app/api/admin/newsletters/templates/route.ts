import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { NEWSLETTER_TEMPLATES } from '@/lib/newsletterContent';

// GET — the curated library (src/lib/newsletterContent.ts), all three languages
// of every entry.
//
// Served over the wire rather than imported by the composer: the library is
// ~40 KB of prose in three languages, and importing it into a client component
// would put all of it in the bundle of a page that most admins open a few times
// a year. It is also admin-only content — the picker is the only reader.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return NextResponse.json({ templates: NEWSLETTER_TEMPLATES });
}
