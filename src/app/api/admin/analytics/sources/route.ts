import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { withTenantScope } from '@/lib/orgContext';

const HIRED = new Set(['HIRED_660', 'EMPLOYED_700']);

// GET — premium source-conversion report (Faz 2, #539): per referral source,
// how many mentees came in and what share ended up hired. Same premium gate as
// cohort comparison (premiumAnalytics setting; basic analytics stay free).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if ((await getSetting('premiumAnalytics')) !== 'true') {
    return NextResponse.json({ error: 'feature_locked' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
  const sources = await prisma.source.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      users: {
        where: { role: 'MENTEE' },
        select: { menteeRelations: { select: { pipelineStatus: true } } },
      },
    },
  });

  const rows = sources.map((s) => {
    const mentees = s.users.length;
    const inPipeline = s.users.filter((u) => u.menteeRelations.length > 0).length;
    // A mentee counts as hired when ANY of their relations reached a hired stage.
    const hired = s.users.filter((u) => u.menteeRelations.some((r) => HIRED.has(r.pipelineStatus))).length;
    return {
      id: s.id,
      name: s.name,
      mentees,
      inPipeline,
      hired,
      conversionToHired: mentees ? Math.round((hired / mentees) * 100) : 0,
    };
  });

  // Mentees with no source at all, so the report accounts for everyone.
  const unsourced = await prisma.user.count({ where: { role: 'MENTEE', sourceId: null } });

  return NextResponse.json({ sources: rows, unsourced });
  });
}
