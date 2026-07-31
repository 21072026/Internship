import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';
import { generateApiKey } from '@/lib/apiKey';

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'ADMIN' ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Never return the key/hash.
  const keys = await prisma.apiKey.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, lastUsedAt: true, createdAt: true },
  });
  return NextResponse.json({ keys });
}

const schema = z.object({ name: z.string().min(1).max(80) });

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { raw, hash } = generateApiKey();
  const key = await prisma.apiKey.create({ data: { name: parsed.data.name, hashedKey: hash } });
  await logActivity({
    action: 'apikey.created',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'apikey',
    targetId: key.id,
    detail: key.name,
    request,
  });
  // The raw key is shown exactly once.
  return NextResponse.json({ id: key.id, name: key.name, key: raw }, { status: 201 });
}

export async function DELETE(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id') || '';
  const { count } = await prisma.apiKey.deleteMany({ where: { id } });
  if (count) {
    await logActivity({
      action: 'apikey.revoked',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'apikey',
      targetId: id,
      request,
    });
  }
  return NextResponse.json({ ok: true });
}
