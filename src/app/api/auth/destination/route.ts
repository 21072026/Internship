import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { postLoginDestination } from '@/lib/postLoginDestination';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const destination = await postLoginDestination(session.user.id, session.user.role);
  return NextResponse.json({ destination });
}
