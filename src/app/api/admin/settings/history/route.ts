import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { GLOBAL_SETTING_KEYS, SETTING_DEFAULTS, type SettingKey } from '@/lib/settings';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { isSuperAdmin } from '@/lib/superAdmin';

// GET ?key=&limit= — the settings change history of the CALLER'S org (#1623),
// newest first: who · when · old → new, from the `SettingChange` rows that
// writeSetting()/revertSetting() write. The org comes from the session, never
// from the query string, so another tenant's rows are unreachable. A redacted
// key reads "[redacted]" here because that is all the row holds.
//
// The global layer (orgId NULL — retention windows and the other
// deployment-wide keys) is the operator's: its rows are added for a super
// admin only. An actor outside the caller's org (the operator) is shown as
// such, without a name or an address.
const MAX_LIMIT = 100;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const key = params.get('key');
  if (key !== null && !(key in SETTING_DEFAULTS)) return NextResponse.json({ error: 'Unknown setting' }, { status: 400 });
  const limit = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '20', 10) || 20, 1), MAX_LIMIT);

  const orgId = await settingsOrgOf(session);
  const layers: object[] = [{ orgId }];
  if (await isSuperAdmin(session)) layers.push({ orgId: null, key: { in: [...GLOBAL_SETTING_KEYS] } });

  const rows = await prisma.settingChange.findMany({
    where: { AND: [{ OR: layers }, key ? { key } : {}] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });

  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => Boolean(id)))];
  const colleagues = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds }, orgId }, select: { id: true, fullName: true, email: true } })
    : [];
  const byId = new Map(colleagues.map((u) => [u.id, u]));

  return NextResponse.json({
    items: rows.map((r) => {
      const colleague = r.actorId ? byId.get(r.actorId) : undefined;
      return {
        id: r.id,
        key: r.key as SettingKey,
        scope: r.programId ? 'program' : r.orgId ? 'org' : 'global',
        oldValue: r.oldValue,
        newValue: r.newValue,
        createdAt: r.createdAt,
        actor: colleague
          ? { name: colleague.fullName, email: colleague.email }
          : r.actorId
            ? { operator: true }
            : { system: true },
      };
    }),
  });
}
