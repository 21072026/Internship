import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { getSettings, SETTING_DEFAULTS, type SettingKey } from '@/lib/settings';
import { logActivity } from '@/lib/activity';

// GET — current settings (with defaults filled in).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ settings: await getSettings() });
}

const schema = z.object({
  reminderDays: z.string().regex(/^\d{1,3}$/).optional(),
  supportEmail: z.string().email().or(z.literal('')).optional(),
  weeklyDigest: z.enum(['true', 'false']).optional(),
  retentionMonths: z.string().regex(/^\d{1,3}$/).optional(),
});

// PUT — upsert one or more settings.
export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const entries = Object.entries(parsed.data).filter(([k]) => k in SETTING_DEFAULTS) as [SettingKey, string][];
  await Promise.all(
    entries.map(([key, value]) =>
      prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    )
  );
  await logActivity({ action: 'settings.update', actorId: session.user.id, actorEmail: session.user.email ?? null });
  return NextResponse.json({ settings: await getSettings() });
}
