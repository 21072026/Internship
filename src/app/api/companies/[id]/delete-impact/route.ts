import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

// What deleting this company would cost (#2441).
//
// The delete route itself has existed for a long time; what was missing is the
// sentence before it. `window.confirm("Are you sure you want to delete X?")`
// names the company and nothing else, so the one fact an admin needs — that six
// kinds of row go WITH it and six others merely lose their link — was only
// discoverable by doing it.
//
// The split is read straight off `prisma/schema.prisma` rather than being a
// policy of its own: a relation declared `onDelete: Cascade` disappears with the
// company, and an optional `companyId` (explicitly `SetNull`, or by Prisma's
// default for a nullable reference) survives with that column emptied. Keeping
// the two lists here, next to each other and in one place, is what makes it
// possible to notice when a NEW relation is added on either side.
//
// ADMIN-only and inside `withTenantScope`, matching the DELETE it precedes
// exactly: a count of an account's records is the same fact as the records.

/** Relations that MySQL deletes along with the company row. */
const CASCADE_COUNTS = {
  needs: true,
  entitlements: true,
  needAlerts: true,
  interests: true,
  requisitions: true,
  interviewRequests: true,
} as const;

/** Relations that survive the delete with their `companyId` set to NULL. */
const DETACH_COUNTS = {
  mentorships: true,
  projects: true,
  offers: true,
  placements: true,
  users: true,
  fromInquiries: true,
} as const;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      const company = await prisma.company.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          _count: { select: { ...CASCADE_COUNTS, ...DETACH_COUNTS } },
        },
      });

      if (!company) {
        return NextResponse.json({ error: 'Company not found' }, { status: 404 });
      }

      const counts = company._count;
      const pick = (bucket: Record<string, true>) =>
        Object.fromEntries(
          Object.keys(bucket)
            .map((key) => [key, counts[key as keyof typeof counts] ?? 0] as const)
            // Only what is actually there: a dialog listing "0 offers" reads as
            // noise and buries the two lines that matter.
            .filter(([, count]) => count > 0)
        ) as Record<string, number>;

      return NextResponse.json({
        impact: {
          name: company.name,
          cascade: pick(CASCADE_COUNTS),
          detach: pick(DETACH_COUNTS),
        },
      });
    });
  } catch (error) {
    console.error('Company delete impact error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
