import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { getSetting } from '@/lib/settings';
import {
  ORPHAN_APPLICANT_GRACE_DAYS,
  ORPHAN_GRACE_SETTING_KEY,
  countOrphanApplicants,
  listOrphanApplicants,
} from '@/lib/orphanApplicant';

// GET — the DRY RUN (#1780).
//
// Every orphan applicant account, whatever its age, with the count and the
// number of days each one has left before the nightly retention sweep
// anonymizes it. Read-only on purpose: this route never erases anything, and
// the per-row actions on the page it feeds go to the endpoints that already
// exist (`POST /api/admin/users/[id]/erase` for the erasure gates,
// `POST /api/admin/users/[id]/reset-password` to send an activation link).
// There is no second deletion path.
//
// It shares `listOrphanApplicants()` with the sweep, so the list an admin reads
// and the set the job takes cannot drift apart.
//
// The list is capped: a backlog of thousands is a number to act on, not a page
// to scroll, and `total` reports the real size either way.
const MAX_ROWS = 200;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = Number.parseInt(await getSetting(ORPHAN_GRACE_SETTING_KEY), 10);
    // Same fallback contract as the retention runner: an unusable setting must
    // widen nothing and shorten nothing.
    const graceDays =
      Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : ORPHAN_APPLICANT_GRACE_DAYS;

    // The sweep's own cutoff, computed the same way the runner computes it —
    // so "due" here means precisely "the next run takes this one".
    const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
    const [items, total, due] = await Promise.all([
      listOrphanApplicants({ graceDays, take: MAX_ROWS }),
      countOrphanApplicants(),
      // Counted in the database rather than over `items`, or a truncated list
      // would under-report the number that is about to be erased.
      countOrphanApplicants(cutoff),
    ]);

    return NextResponse.json({
      graceDays,
      total,
      due,
      truncated: total > items.length,
      items,
    });
  });
}
