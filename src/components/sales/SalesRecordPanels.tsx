'use client';

import { useRouter } from 'next/navigation';
import { FollowUpPanel } from '@/components/FollowUpPanel';
import { TrialEndPanel } from '@/components/TrialEndPanel';

// The two editors a sales rep has on their own record (#2580): the follow-up
// (#2563, PUT /api/mentorship/[id] — owner or ADMIN) and the trial end (#2553,
// PATCH /api/mentorship/[id]/trial — owner or ADMIN, `pipeline` capability).
// The page around them is a server component, so a save refreshes it — the
// badges and the attention queue are server-rendered.
export function SalesRecordPanels({
  relationId,
  status,
  pipelineStatus,
  nextActionAt,
  nextActionNote,
  trialStartedAt,
  trialEndsAt,
}: {
  relationId: string;
  status: string;
  pipelineStatus: string;
  nextActionAt: string | null;
  nextActionNote: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
}) {
  const router = useRouter();
  const refresh = () => router.refresh();
  return (
    <>
      <div className="mb-6">
        <FollowUpPanel
          relationId={relationId}
          nextActionAt={nextActionAt}
          nextActionNote={nextActionNote}
          onSaved={refresh}
        />
      </div>
      {/* Nothing renders outside a trial. */}
      <div className="mb-6 empty:hidden">
        <TrialEndPanel
          relationId={relationId}
          pipelineStatus={pipelineStatus}
          trialStartedAt={trialStartedAt}
          trialEndsAt={trialEndsAt}
          canEdit={status === 'ACTIVE'}
          onSaved={refresh}
        />
      </div>
    </>
  );
}
