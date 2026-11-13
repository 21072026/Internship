'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { FollowUpPanel } from '@/components/FollowUpPanel';
import { TrialEndPanel } from '@/components/TrialEndPanel';
import { ContractEndPanel } from '@/components/ContractEndPanel';
import { WinBackPanel } from '@/components/WinBackPanel';
import { DealValuePanel, type DealValueState } from '@/components/DealValuePanel';

// The editors a sales rep has on their own record (#2580): the follow-up
// (#2563, PUT /api/mentorship/[id] — owner or ADMIN) and the trial end (#2553,
// PATCH /api/mentorship/[id]/trial — owner or ADMIN, `pipeline` capability).
// The page around them is a server component, so a save refreshes it — the
// badges and the attention queue are server-rendered.
//
// Layout (#3653): the follow-up stays full width with the last interaction right
// under it — what comes next, then what happened last. The date and value panels
// (trial end, win-back, contract end, estimated value) share a grid instead of
// each taking a full-width row for a narrow input; a panel that does not render
// for the record's stage is `empty:hidden`, so it leaves no hole in the grid.
export function SalesRecordPanels({
  relationId,
  status,
  pipelineStatus,
  nextActionAt,
  nextActionNote,
  trialStartedAt,
  trialEndsAt,
  contractEndsAt,
  dealValue,
  lastInteraction,
}: {
  relationId: string;
  status: string;
  pipelineStatus: string;
  nextActionAt: string | null;
  nextActionNote: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  contractEndsAt: string | null;
  dealValue: DealValueState;
  /** Rendered between the follow-up and the date/value panels (server-built by the page). */
  lastInteraction?: ReactNode;
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
          pipelineStatus={pipelineStatus}
          onSaved={refresh}
        />
      </div>
      {lastInteraction && <div className="mb-6">{lastInteraction}</div>}
      <div className="mb-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-2 2xl:grid-cols-3" data-testid="sales-record-panels-grid">
        {/* Nothing renders outside a trial. */}
        <div className="empty:hidden">
          <TrialEndPanel
            relationId={relationId}
            pipelineStatus={pipelineStatus}
            trialStartedAt={trialStartedAt}
            trialEndsAt={trialEndsAt}
            canEdit={status === 'ACTIVE'}
            onSaved={refresh}
          />
        </div>
        {/* A lost customer came back (#2842); renders on an open DEAL_LOST record only. */}
        <div className="empty:hidden">
          <WinBackPanel
            relationId={relationId}
            pipelineStatus={pipelineStatus}
            status={status}
            hrefFor={(id) => `/sales/leads/${id}`}
          />
        </div>
        {/* A won customer's notice period (#2841); renders on DEAL_WON only. */}
        <div className="empty:hidden">
          <ContractEndPanel
            relationId={relationId}
            pipelineStatus={pipelineStatus}
            contractEndsAt={contractEndsAt}
            canEdit={status === 'ACTIVE'}
            onSaved={refresh}
          />
        </div>
        {/* The estimated monthly value (#2422, PUT /api/mentorship/[id]/value —
            owner or ADMIN). */}
        <div>
          <DealValuePanel relationId={relationId} initial={dealValue} onSaved={refresh} />
        </div>
      </div>
    </>
  );
}
